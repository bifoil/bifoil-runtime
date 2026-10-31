// Explicit typed host boundary. Hosts execute legacy code; this module checks
// values and preserves the Bifoil continuation at fully prepared input waits.
import { check, BifoilError, haltExecution } from "./errors.mjs";
import { validateInput } from "./legacy/input.mjs";
import { fromLegacy, toLegacy, boundaryType } from "./legacy/values.mjs";

export function copyJson(data) {
  let text;
  try {
    text = JSON.stringify(data, (key, value) => {
      check(
        value === null || ["object", "string", "boolean", "number"].includes(typeof value),
        "legacy snapshot is not plain data",
      );
      check(
        typeof value !== "number" || (Number.isFinite(value) && !Object.is(value, -0)),
        "legacy snapshot must encode special numbers",
      );
      return value;
    });
  } catch (failure) {
    throw new BifoilError("invalid legacy snapshot: " + failure.message);
  }
  check(typeof text === "string" && text.length <= 16 * 1024 * 1024, "legacy snapshot budget exceeded");
  return JSON.parse(text);
}
function host(machine, method) {
  check(typeof machine.legacy?.[method] === "function", "legacy host requires " + method);
  machine.state.legacyUsed = true;
  return machine.legacy;
}
export function installLegacyCells(machine) {
  for (const [name, definition] of Object.entries(machine.program.legacy_globals ?? {})) {
    check(!Object.hasOwn(machine.state.envs[0].bindings, name), "duplicate legacy binding");
    const cell =
      machine.state.cells.push({
        ty: definition.ty,
        mutable: definition.mutable,
        initialized: false,
        value: null,
        legacy: name,
      }) - 1;
    check(cell < 100000, "runtime heap budget exceeded");
    Object.defineProperty(machine.state.envs[0].bindings, name, { value: cell, enumerable: true, configurable: true });
  }
}
export function readLegacy(machine, name) {
  const definition = machine.program.legacy_globals[name];
  return fromLegacy(invoke(machine, "read", definition.target), definition.ty, machine);
}
export function writeLegacy(machine, name, item) {
  const definition = machine.program.legacy_globals[name];
  check(definition.mutable, "cannot assign to legacy val");
  invoke(machine, "write", definition.target, toLegacy(item, definition.ty, machine));
}
function request(machine, frame, instruction) {
  return { target: instruction.target, suspend: machine.program.functions[frame.function].signature.suspend };
}
function publishOutput(machine, output) {
  if (!output?.length) return;
  machine.flushProse();
  for (const paragraph of output) machine.emitOutput(paragraph);
}
function invoke(machine, method, ...arguments_) {
  try {
    return host(machine, method)[method](...arguments_);
  } catch (failure) {
    if (Array.isArray(failure.legacyOutput) && failure.legacyOutput.every((text) => typeof text === "string"))
      publishOutput(machine, failure.legacyOutput);
    if (failure instanceof BifoilError && failure.span) throw failure;
    throw new BifoilError(failure.message, machine.span);
  }
}
function acceptReply(machine, frame, instruction, reply) {
  check(reply && ["returned", "waiting", "transferred"].includes(reply.status), "invalid legacy call result");
  check(
    reply.output === undefined ||
      (Array.isArray(reply.output) && reply.output.every((text) => typeof text === "string")),
    "invalid legacy output",
  );
  publishOutput(machine, reply.output);
  if (reply.status === "transferred") {
    check(instruction.target.transfer === true, "ordinary legacy bridge cannot transfer");
    machine.closeProse(0);
    machine.state.frames = [];
    machine.state.boot = [];
    machine.state.pending = null;
    machine.state.done = true;
    return;
  }
  if (reply.status === "returned") {
    check(!instruction.target.transfer, "legacy transfer bridge cannot return");
    frame.stack.push(fromLegacy(reply.value, machine.program.functions[frame.function].signature.result, machine));
    machine.state.pending = null;
    return;
  }
  check(machine.program.functions[frame.function].signature.suspend, "legacy input requires a suspend function");
  validateLegacyOptions(reply.options);
  if (reply.input !== undefined) {
    validateInput(reply.input);
    check(reply.options.length === 0, "native input cannot also offer choices");
  }
  machine.state.pending = {
    kind: "legacy",
    frame: machine.state.frames.length - 1,
    options: reply.options.map(({ label, enabled }) => ({ label, enabled })),
    continuation: copyJson(reply.continuation),
    ...(reply.input === undefined ? {} : { input: copyJson(reply.input) }),
  };
}
export function callLegacy(machine, instruction, frame) {
  const count = instruction.arguments;
  check(Number.isInteger(count) && count >= 0 && frame.stack.length >= count, "invalid legacy argument count");
  const signature = machine.program.functions[frame.function].signature;
  check(count === signature.params.length, "invalid legacy wrapper signature");
  const items = frame.stack.splice(frame.stack.length - count, count);
  const args = [];
  for (const [index, item] of items.entries()) {
    const parameter = signature.params[index];
    if (parameter.vararg) {
      check(item.kind === "list", "legacy vararg requires a List");
      for (const element of machine.object(item).items) args.push(toLegacy(element, parameter.ty, machine));
    } else args.push(toLegacy(item, parameter.ty, machine));
  }
  if (instruction.target.transfer) {
    machine.closeProse(0);
    machine.state.frames = [frame];
    machine.state.boot = [];
  }
  const reply = invoke(machine, "start", { ...request(machine, frame, instruction), args });
  acceptReply(machine, frame, instruction, reply);
}
export function chooseLegacy(machine, index) {
  const pending = machine.state.pending;
  const frame = machine.state.frames.at(-1);
  const instruction = machine.program.functions[frame.function].code[frame.pc - 1];
  machine.span = instruction.span;
  try {
    const reply = invoke(
      machine,
      "resume",
      request(machine, frame, instruction),
      copyJson(pending.continuation),
      index,
    );
    acceptReply(machine, frame, instruction, reply);
  } catch (failure) {
    throw haltExecution(machine, failure);
  }
  return machine.run();
}
const legacyInterfaces = new WeakMap();
function hasLegacyInterfaces(program) {
  if (!legacyInterfaces.has(program)) {
    const globals = Object.keys(program.legacy_globals ?? {}).length > 0;
    const calls = Object.values(program.functions).some((fn) =>
      fn.code.some((instruction) => instruction.op === "legacy_call"),
    );
    legacyInterfaces.set(program, globals || calls);
  }
  return legacyInterfaces.get(program);
}
export function saveLegacyHost(machine) {
  // A first Bifoil input wait may precede every legacy read or call. Preserve
  // provided host state now; a fresh host must not invent its earlier values.
  if (machine.state.legacyUsed || (machine.legacy && hasLegacyInterfaces(machine.program))) {
    machine.state.legacyHost = copyJson(host(machine, "snapshot").snapshot());
  }
}
export function restoreLegacyHost(machine) {
  if (machine.state.legacyUsed) {
    check(machine.state.legacyHost !== undefined, "missing saved legacy host state");
    host(machine, "restore").restore(copyJson(machine.state.legacyHost));
  }
}
export function validateLegacyOptions(options) {
  check(Array.isArray(options) && options.length <= 10000, "invalid legacy choice options");
  check(
    options.every((option) => option && typeof option.label === "string" && typeof option.enabled === "boolean"),
    "invalid legacy option",
  );
}
export function validateLegacyProgram(program) {
  check(
    program.legacy_globals === undefined ||
      (program.legacy_globals && !Array.isArray(program.legacy_globals) && typeof program.legacy_globals === "object"),
    "invalid legacy bindings",
  );
  for (const definition of Object.values(program.legacy_globals ?? {})) {
    check(
      boundaryType(definition.ty, false, program.types) &&
        typeof definition.mutable === "boolean" &&
        typeof definition.target === "string",
      "invalid legacy binding interface",
    );
  }
  check(
    program.legacy_sources === undefined ||
      (program.legacy_sources &&
        !Array.isArray(program.legacy_sources) &&
        typeof program.legacy_sources === "object" &&
        Object.values(program.legacy_sources).every((text) => typeof text === "string")),
    "invalid legacy sources",
  );
  for (const fn of Object.values(program.functions))
    for (const instruction of fn.code) {
      if (instruction.op !== "legacy_call") continue;
      const target = instruction.target;
      check(
        target &&
          typeof target.scene === "string" &&
          (target.label === null || typeof target.label === "string") &&
          (target.result === null || typeof target.result === "string"),
        "invalid legacy call target",
      );
      check(
        (fn.signature.generics ?? []).length === 0 &&
          instruction.arguments === fn.signature.params.length &&
          (target.transfer === true
            ? fn.signature.suspend && fn.signature.result.kind === "nothing" && target.result === null
            : boundaryType(fn.signature.result, true, program.types) &&
              (fn.signature.result.kind === "unit" || target.result !== null)) &&
          fn.signature.params.every(
            (parameter, index) =>
              boundaryType(parameter.ty, false, program.types) &&
              (!parameter.vararg || index === fn.signature.params.length - 1),
          ),
        "invalid legacy call interface",
      );
    }
}
