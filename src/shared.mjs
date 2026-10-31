// Once-only shared initialization in the compiler-proven dependency order.
// No initializer can suspend, so checkpoints contain completed shared cells only.
import { check } from "./errors.mjs";

export function installSharedCells(machine) {
  for (const [name, definition] of Object.entries(machine.program.shared ?? {})) {
    check(machine.state.cells.length < 100000, "runtime heap budget exceeded");
    check(!Object.hasOwn(machine.state.envs[0].bindings, name), "duplicate shared binding " + name);
    const id =
      machine.state.cells.push({
        ty: definition.ty,
        mutable: definition.mutable,
        initialized: false,
        value: null,
      }) - 1;
    Object.defineProperty(machine.state.envs[0].bindings, name, {
      value: id,
      enumerable: true,
      configurable: true,
    });
  }
}

/** Start only from the compiled startup plan, after every dependency completed. */
export function startSharedInitialization(machine, name) {
  const definition = machine.program.shared[name];
  const cell = machine.cell(0, name);
  check(cell.initialized === false && !cell.initializing, "shared initializer ran twice");
  for (const dependency of definition.dependencies) {
    check(machine.cell(0, dependency).initialized === true, "shared dependency is not initialized: " + dependency);
  }
  cell.initializing = true;
  machine.pushCall({ kind: "function", id: definition.initializer, env: 0 }, [], [], { direct: true, boot: true });
  machine.state.frames.at(-1).sharedInitialization = name;
}

export function finishSharedInitialization(machine, frame, result) {
  if (frame.sharedInitialization === undefined) return false;
  const cell = machine.cell(0, frame.sharedInitialization);
  check(cell.initializing && cell.initialized === false, "invalid shared initialization state");
  check(machine.acceptsType(cell.ty, machine.valueType(result)), "shared initializer type mismatch");
  cell.value = result;
  cell.initialized = true;
  delete cell.initializing;
  return true;
}
