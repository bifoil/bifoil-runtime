import { programCode } from "./program-code.mjs";
import { assertScalarText, joinText } from "./text.mjs";
import { indexNamedCaptures } from "./closure-captures.mjs";
import { rootFunction } from "./functions.mjs";
import { installLegacyCells, readLegacy, writeLegacy, callLegacy, chooseLegacy, restoreLegacyHost } from "./legacy.mjs";
import { collectGarbage, collectIfNeeded } from "./collector.mjs";
import { installSharedCells, startSharedInitialization, finishSharedInitialization } from "./shared.mjs";
// Execution loop and public host-facing VM API.
import { BifoilError, check, ensureLive, haltExecution } from "./errors.mjs";
import { value, unit, int, float, format, isNumeric as numeric } from "./values.mjs";
import { RuntimeMembers } from "./members.mjs";
import { executeInstruction } from "./operations.mjs";
import { validateCheckpoint, serializeCheckpoint, parseCheckpoint } from "./validation.mjs";
import { validateProgram } from "./program.mjs";

export { BifoilError } from "./errors.mjs";
export { binary } from "./numeric.mjs";
export { format } from "./values.mjs";
export { PROFILE, validateProgram } from "./program.mjs";

const OWN = (object, key) => Object.hasOwn(object, key);
const clone = (data) => JSON.parse(JSON.stringify(data));

export class VM extends RuntimeMembers {
  constructor(program, restoredState = null, { legacy = null, quantum = 1000000, beforeRestore = null } = {}) {
    super();
    this.program = validateProgram(program);
    this.namedCaptures = indexNamedCaptures(program);
    this.legacy = legacy;
    check(Number.isInteger(quantum) && quantum > 0, "invalid execution quantum");
    this.quantum = quantum;
    this.events = [];
    this.span = null;
    this.state = restoredState ?? {
      format: "bifoil.checkpoint.v2",
      profile: program.profile,
      build: program.build,
      cells: [],
      envs: [{ parent: null, bindings: {} }],
      frames: [],
      boot: [...(program.shared_order ?? program.init), program.entry],
      pending: null,
      done: false,
      transcript: [],
    };
    this.state.objects ??= [];
    this.state.history ??= {};
    this.state.prose ??= [];
    if (restoredState) {
      this.validateState();
      beforeRestore?.();
      restoreLegacyHost(this);
    } else {
      installSharedCells(this);
      installLegacyCells(this);
      for (const [name, input, result] of [
        ["Int", { kind: "float" }, { kind: "int" }],
        ["Float", { kind: "float" }, { kind: "float" }],
        ["String", { kind: "nullable", inner: { kind: "any" } }, { kind: "string" }],
        ["Char", { kind: "int" }, { kind: "char" }],
      ]) {
        const type = { kind: "function", params: [input], result, suspend: false };
        this.declare(0, "$builtin." + name, type, false, { kind: "builtin", name, receiver: null, type });
      }
      if (program.profile === "bifoil-vm.v1") {
        for (const id of Object.keys(program.functions)) {
          const fn = rootFunction(program, id);
          if (fn) this.declare(0, id, this.functionType(fn.signature), false, { kind: "function", id, env: 0 });
        }
      }
    }
  }
  // The current body is an execution handle, separate from the evictable
  // package cache. Returning to an evicted caller fetches its body at its saved
  // PC; call setup, arguments, defaults, and completed output do not repeat.
  frameCode(id) {
    if (this.activeCode?.id === id) return this.activeCode.code;
    const code = this.program.functions[id].code;
    if (code) {
      this.activeCode = { id, code };
      return code;
    }
    if (!this.loading) {
      const ready = programCode(this.program)
        .loadFunction(id)
        .then(
          (code) => {
            this.activeCode = { id, code };
            this.loading = null;
          },
          (error) => {
            throw haltExecution(this, error);
          },
        );
      this.loading = { status: "loading", ready };
    }
    return null;
  }
  async runAsync(maxSteps = this.quantum) {
    const output = [];
    try {
      let result = this.run(maxSteps);
      while (result.status === "loading") {
        for (const paragraph of result.output) output.push(paragraph);
        await result.ready;
        result = this.run(maxSteps);
      }
      for (const paragraph of result.output) output.push(paragraph);
      return { ...result, output };
    } catch (error) {
      // Earlier loading results have already drained their completed output.
      // Return it to the public drain queue before any later failed-slice text.
      for (const paragraph of this.events) output.push(paragraph);
      this.events = output;
      throw error;
    }
  }
  validateState() {
    validateCheckpoint(this);
  }
  static restore(program, checkpoint, options = {}) {
    return new VM(program, parseCheckpoint(checkpoint), options);
  }

  save() {
    ensureLive(this);
    check(this.state.pending !== null, "saves require a fully prepared input checkpoint");
    collectGarbage(this);
    return serializeCheckpoint(this);
  }

  emitOutput(paragraph) {
    assertScalarText(paragraph, "output text");
    this.events.push(paragraph);
    this.state.transcript.push(paragraph);
  }
  drainOutput() {
    return this.events.splice(0);
  }
  flushProse(index = null) {
    const indexes = index === null ? this.state.prose.map((_, i) => i) : [index];
    for (const i of indexes) {
      const paragraph = this.state.prose[i];
      check(typeof paragraph === "string", "invalid prose context");
      if (paragraph.length) {
        this.emitOutput(paragraph);
        this.state.prose[i] = "";
      }
    }
  }

  closeProse(depth) {
    check(Number.isInteger(depth) && depth >= 0 && depth <= this.state.prose.length, "invalid prose unwind");
    while (this.state.prose.length > depth) {
      this.flushProse(this.state.prose.length - 1);
      this.state.prose.pop();
    }
  }
  choose(index) {
    ensureLive(this);
    const pending = this.state.pending;
    check(
      pending && Number.isInteger(index) && index >= 0 && index < pending.options.length,
      "invalid choice selection",
    );
    check(pending.options[index].enabled, "option is disabled");
    if (pending.kind === "legacy") return chooseLegacy(this, index);
    const site = pending.options[index].once;
    if (site) Object.defineProperty(this.state.history, site, { value: true, enumerable: true, configurable: true });
    this.state.frames[pending.frame].pc = pending.options[index].target;
    this.state.frames[pending.frame].choice = [];
    this.state.pending = null;
    return this.run();
  }
  submit(response) {
    ensureLive(this);
    check(
      this.state.pending?.kind === "legacy" && this.state.pending.input && typeof response === "string",
      "no text or number input is waiting",
    );
    assertScalarText(response, "input text");
    return chooseLegacy(this, response);
  }
  run(maxSteps = this.quantum) {
    ensureLive(this);
    check(Number.isInteger(maxSteps) && maxSteps > 0, "invalid execution quantum");
    let steps = 0;
    try {
      while (!this.state.pending && !this.state.done) {
        collectIfNeeded(this);
        if (!this.state.frames.length) {
          const next = this.state.boot.shift();
          if (!next) {
            this.state.done = true;
            break;
          }
          if (Object.hasOwn(this.program.shared ?? {}, next)) {
            startSharedInitialization(this, next);
          } else
            this.pushCall(
              {
                kind:
                  this.program.functions[next].signature.scene && this.program.profile !== "bifoil-vm.v1"
                    ? "scene"
                    : "function",
                id: next,
                env: 0,
              },
              [],
              [],
              { direct: true, boot: true },
            );
        }
        if (steps++ >= maxSteps) break;
        const frame = this.state.frames.at(-1);
        const fn = this.program.functions[frame.function];
        const code = this.frameCode(frame.function);
        if (!code) return { ...this.loading, output: this.drainOutput(), options: [] };
        const op = code[frame.pc++];
        check(op, "execution ran past function body");
        this.span = op.span;
        const stack = frame.stack;
        const pop = () => {
          check(stack.length > 0, "invalid operand stack");
          return stack.pop();
        };
        if (executeInstruction(this, op, frame, pop)) continue;
        switch (op.op) {
          case "unreachable":
            throw new BifoilError("reached unreachable control flow", this.span);
          case "constant": {
            const v = value(op.ty.kind, op.value);
            check(this.validValue(v) && op.ty.kind !== "function", "invalid constant");
            stack.push(v);
            break;
          }
          case "legacy_call":
            callLegacy(this, op, frame);
            break;
          case "load": {
            const c = this.cell(frame.env, op.name);
            if (c.legacy) {
              stack.push(readLegacy(this, c.legacy));
              break;
            }
            check(c.initialized !== false, "binding is not initialized");
            stack.push(c.value);
            break;
          }
          case "declare":
            this.declare(frame.env, op.name, this.resolveType(op.ty, frame), op.mutable, pop());
            break;
          case "store": {
            const c = this.cell(frame.env, op.name);
            if (c.legacy) {
              writeLegacy(this, c.legacy, pop());
              break;
            }
            check(
              !Object.hasOwn(this.program.shared ?? {}, op.name) || c.initialized === true,
              "shared binding is not initialized",
            );
            const v = pop();
            check(
              (c.mutable || c.initialized === false) && this.acceptsType(c.ty, this.valueType(v)),
              "invalid binding assignment",
            );
            c.value = v;
            c.initialized = true;
            break;
          }
          case "closure": {
            const fn = this.program.functions[op.function];
            const type = this.closureType(fn.signature, frame);
            this.declareCell(frame.env, op.name, type, false, {
              kind: "function",
              id: op.function,
              env: frame.env,
              typeArgs: { ...frame.typeArgs },
              type,
            });
            break;
          }
          case "pop":
            pop();
            break;
          case "dup": {
            const v = pop();
            stack.push(v, v);
            break;
          }
          case "widen": {
            const v = pop();
            check(v.kind === "int", "invalid widening");
            stack.push(float(v.value));
            break;
          }
          case "unary": {
            const a = pop();
            if (op.operator === "!") {
              check(a.kind === "boolean", "Boolean operand required");
              stack.push(value("boolean", !a.value));
            } else {
              check(op.operator === "-" && numeric(a), "invalid unary operand");
              stack.push(a.kind === "int" ? int(-a.value) : float(-a.value));
            }
            break;
          }
          case "exact_compare": {
            const b = pop(),
              a = pop();
            const equal = this.exactCompare(
              a,
              b,
              this.resolveType(op.left_type, frame),
              this.resolveType(op.right_type, frame),
            );
            stack.push(value("boolean", op.negate ? !equal : equal));
            break;
          }
          case "binary": {
            const b = pop(),
              a = pop();
            stack.push(this.binary(op.operator, a, b));
            break;
          }
          case "jump":
            frame.pc = op.target;
            break;
          case "jump_false":
          case "jump_true": {
            const condition = pop();
            check(condition.kind === "boolean", "Boolean condition required");
            if (condition.value === (op.op === "jump_true")) frame.pc = op.target;
            break;
          }
          case "enter":
            frame.env = this.environment(frame.env);
            break;
          case "exit":
            check(this.state.envs[frame.env].parent !== null, "invalid scope exit");
            frame.env = this.state.envs[frame.env].parent;
            break;
          case "default":
            if (OWN(this.state.envs[frame.env].bindings, op.name)) frame.pc = op.target;
            break;
          case "call": {
            check(Array.isArray(op.names) && stack.length > op.names.length, "invalid call operands");
            const args = stack.splice(stack.length - op.names.length, op.names.length);
            const callable = pop();
            const target = this.program.functions[callable.id];
            check(!target?.signature.suspend || fn.signature.suspend, "invalid suspension effect");
            this.pushCall(callable, args, op.names, {
              direct: op.direct,
              spreads: op.spreads ?? [],
              typeArgs: op.type_args ?? {},
            });
            break;
          }
          case "return": {
            const result = pop();
            check(
              this.acceptsType(this.resolveType(fn.signature.result, frame), this.valueType(result)),
              "invalid return type",
            );
            this.closeProse(frame.proseBase ?? 0);
            this.state.frames.pop();
            if (!finishSharedInitialization(this, frame, result) && this.state.frames.length) {
              this.state.frames.at(-1).stack.push(result);
            }
            break;
          }
          case "format": {
            check(Number.isInteger(op.count) && op.count >= 0 && stack.length >= op.count, "invalid interpolation");
            stack.push(value("string", joinText(stack.splice(stack.length - op.count, op.count).map(format))));
            break;
          }
          case "print": {
            const v = pop();
            check(v.kind === "string", "prose must be String");
            this.emitOutput(v.value);
            break;
          }
          case "begin_choice":
            frame.choice = [];
            break;
          case "offer": {
            const label = pop(),
              enabled = pop();
            check(label.kind === "string" && enabled.kind === "boolean", "invalid option");
            frame.choice.push({
              label: label.value,
              enabled: enabled.value,
              target: op.target,
              ...(op.once ? { once: op.once } : {}),
            });
            break;
          }
          case "choose": {
            this.flushProse();
            check(fn.signature.suspend, "choice requires a suspend context");
            if (frame.choice.some((o) => o.enabled))
              this.state.pending = { frame: this.state.frames.length - 1, options: clone(frame.choice) };
            else if (op.fallback !== null) {
              frame.pc = op.fallback;
              frame.choice = [];
            } else throw new BifoilError("choice has no selectable options");
            break;
          }
          default:
            throw new BifoilError("unknown instruction");
        }
      }
    } catch (error) {
      throw haltExecution(this, error);
    }
    if (this.state.done) this.activeCode = null;
    return {
      status: this.state.done ? "done" : this.state.pending ? "waiting" : "running",
      output: this.drainOutput(),
      ...(this.state.pending?.input ? { input: clone(this.state.pending.input) } : {}),
      options: this.state.pending?.options.map((o) => ({ label: o.label, enabled: o.enabled })) ?? [],
    };
  }
}
