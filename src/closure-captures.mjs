// Named closures exist before their captured declarations. Resolve their cell
// references at collection time, and keep the original scope while any are absent.
import { check } from "./errors.mjs";
import { rootFunction } from "./functions.mjs";

export function indexNamedCaptures(program) {
  const sites = new Map();
  for (const fn of Object.values(program.functions)) {
    for (const instruction of fn.code) {
      if (instruction.op !== "closure") continue;
      const names = instruction.captures;
      if (sites.has(instruction.function)) {
        const previous = sites.get(instruction.function);
        const members = new Set(previous);
        check(
          (previous === undefined && names === undefined) ||
            (previous !== undefined &&
              names !== undefined &&
              previous.length === names.length &&
              names.every((name) => members.has(name))),
          "inconsistent named closure captures",
        );
      } else sites.set(instruction.function, names);
    }
  }
  return new Map([...sites].filter(([, names]) => names !== undefined));
}

export class CapturePlans {
  constructor(machine) {
    this.machine = machine;
    this.values = new WeakMap();
    this.environments = new Map();
    this.plans = [];
  }
  forValue(value) {
    if (value.kind !== "function" || value.env === 0) return null;
    const names = this.machine.namedCaptures?.get(value.id);
    if (names === undefined) return null;
    if (this.values.has(value)) return this.values.get(value);
    let functions = this.environments.get(value.env);
    if (!functions) this.environments.set(value.env, (functions = new Map()));
    if (!functions.has(value.id)) functions.set(value.id, this.resolve(value.env, names));
    const plan = functions.get(value.id);
    this.values.set(value, plan);
    return plan;
  }
  resolve(env, names) {
    const bindings = {};
    for (const name of names) {
      const id = this.machine.cellId(env, name);
      if (id === null) {
        if (!rootFunction(this.machine.program, name)) return null;
      } else Object.defineProperty(bindings, name, { value: id, enumerable: true });
    }
    const original = this.machine.state.envs[env];
    const keys = Object.keys(bindings);
    if (
      original.parent === 0 &&
      Object.keys(original.bindings).length === keys.length &&
      keys.every((name) => original.bindings[name] === bindings[name])
    )
      return null;
    const plan = { bindings, env: null };
    this.plans.push(plan);
    return plan;
  }
  appendEnvironments(envs) {
    for (const plan of this.plans) {
      // Cell IDs are still original here and use the collector's ordinary rewrite.
      plan.env = Object.keys(plan.bindings).length ? envs.push({ parent: 0, bindings: plan.bindings }) - 1 : 0;
    }
  }
}
