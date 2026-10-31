import { validScalarOffset } from "./text.mjs";
import { isScalarString } from "./values.mjs";
import { validateInput } from "./legacy/input.mjs";
import { validateLegacyOptions, saveLegacyHost, copyJson } from "./legacy.mjs";
// Checkpoint validation is separate from execution and does not modify VM prototypes.
import { BifoilError, check } from "./errors.mjs";
import { typeValid, sameType } from "./types.mjs";
import { validateHeapObject } from "./checkpoint-heap.mjs";
import { validateFrameCall } from "./checkpoint-callables.mjs";
import { validateStoredKeys } from "./checkpoint-keys.mjs";

export function validateOptions(machine, options, frame) {
  check(Array.isArray(options) && options.length <= 10000, "invalid choice options");
  options.forEach((o) =>
    check(
      o &&
        typeof o.label === "string" &&
        typeof o.enabled === "boolean" &&
        Number.isInteger(o.target) &&
        o.target >= 0 &&
        o.target < machine.program.functions[frame.function].code.length &&
        (o.once === undefined || o.once === null || typeof o.once === "string"),
      "invalid choice option",
    ),
  );
}

export function validateCheckpoint(machine) {
  const s = machine.state;
  check(
    s &&
      ["bifoil.checkpoint.v1", "bifoil.checkpoint.v2"].includes(s.format) &&
      s.profile === machine.program.profile &&
      s.build === machine.program.build,
    "checkpoint belongs to a different build or profile",
  );
  check(
    Array.isArray(s.cells) &&
      Array.isArray(s.envs) &&
      s.envs.length > 0 &&
      Array.isArray(s.objects) &&
      s.cells.length <= 100000 &&
      s.envs.length <= 100000 &&
      s.objects.length <= 100000,
    "invalid checkpoint heap",
  );
  check(Array.isArray(s.prose) && s.prose.every((text) => typeof text === "string"), "invalid prose buffers");
  s.cells.forEach((c) =>
    check(
      c &&
        typeValid(c.ty) &&
        typeof c.mutable === "boolean" &&
        (c.initialized === undefined || typeof c.initialized === "boolean") &&
        (c.initialized === false
          ? c.value === null
          : machine.validValue(c.value) && machine.acceptsType(c.ty, machine.valueType(c.value))),
      "invalid checkpoint cell",
    ),
  );
  s.envs.forEach((e, index) => {
    check(
      e &&
        ((e.parent === null && index === 0) || (Number.isInteger(e.parent) && e.parent >= 0 && e.parent < index)) &&
        e.bindings &&
        typeof e.bindings === "object" &&
        !Array.isArray(e.bindings),
      "invalid checkpoint environment",
    );
    Object.values(e.bindings).forEach((id) =>
      check(Number.isInteger(id) && id >= 0 && id < s.cells.length, "invalid cell reference"),
    );
  });
  for (const [name, definition] of Object.entries(machine.program.shared ?? {})) {
    check(Object.hasOwn(s.envs[0].bindings, name), "missing checkpoint shared binding");
    const cell = machine.cell(0, name);
    check(
      cell.initialized === true &&
        !cell.initializing &&
        cell.mutable === definition.mutable &&
        sameType(cell.ty, definition.ty),
      "incomplete checkpoint shared initialization",
    );
  }
  for (const [name, definition] of Object.entries(machine.program.legacy_globals ?? {})) {
    const cell = machine.cell(0, name);
    check(
      cell.legacy === name &&
        cell.initialized === false &&
        cell.value === null &&
        sameType(cell.ty, definition.ty) &&
        cell.mutable === definition.mutable,
      "invalid legacy proxy cell",
    );
  }
  if (s.legacyUsed) {
    check(s.legacyHost !== undefined, "missing legacy host state");
    copyJson(s.legacyHost);
  }
  s.objects.forEach((object) => validateHeapObject(machine, object));
  validateStoredKeys(machine);
  check(Array.isArray(s.frames) && s.frames.length > 0 && s.frames.length <= 1024, "invalid checkpoint frames");
  s.frames.forEach((f) => {
    check(
      f &&
        Object.hasOwn(machine.program.functions, f.function) &&
        Number.isInteger(f.pc) &&
        f.pc >= 0 &&
        f.pc < machine.program.functions[f.function].code.length &&
        Number.isInteger(f.env) &&
        f.env >= 0 &&
        f.env < s.envs.length &&
        Array.isArray(f.stack) &&
        f.stack.every((v) => machine.validValue(v)) &&
        Array.isArray(f.choice),
      "invalid checkpoint frame",
    );
    check(
      f.proseBase === undefined || (Number.isInteger(f.proseBase) && f.proseBase >= 0 && f.proseBase <= s.prose.length),
      "invalid frame prose context",
    );
    const marks = f.loopMarks ?? [];
    check(Array.isArray(marks), "invalid saved loop stack marks");
    const identifiers = new Set();
    let depth = 0;
    for (const mark of marks) {
      check(
        mark &&
          Number.isSafeInteger(mark.id) &&
          mark.id >= 0 &&
          !identifiers.has(mark.id) &&
          Number.isInteger(mark.depth) &&
          mark.depth >= depth &&
          mark.depth <= f.stack.length &&
          machine.program.functions[f.function].code.some((op) => op.op === "stack_mark" && op.id === mark.id),
        "invalid saved loop stack mark",
      );
      identifiers.add(mark.id);
      depth = mark.depth;
    }
    check(f.sharedInitialization === undefined, "checkpoint cannot interrupt shared initialization");
    validateFrameCall(machine, f);
    validateOptions(machine, f.choice, f);
    for (const iterator of Object.values(f.iterators ?? {})) {
      check(
        iterator &&
          (iterator.range
            ? machine.validValue(iterator.range) &&
              iterator.range.kind === "range" &&
              Number.isInteger(iterator.current) &&
              typeof iterator.done === "boolean"
            : iterator.kind === "string"
              ? isScalarString(iterator.text) && validScalarOffset(iterator.text, iterator.offset)
              : Array.isArray(iterator.items) &&
                iterator.items.every((v) => machine.validValue(v)) &&
                Number.isInteger(iterator.index) &&
                iterator.index >= 0 &&
                iterator.index <= iterator.items.length),
        "invalid suspended traversal",
      );
    }
  });
  check(
    Array.isArray(s.boot) &&
      s.boot.every(
        (id) => Object.hasOwn(machine.program.functions, id) || Object.hasOwn(machine.program.shared ?? {}, id),
      ),
    "invalid checkpoint initialization",
  );
  check(s.done === false && s.pending && s.pending.frame === s.frames.length - 1, "checkpoint is not at an input wait");
  check(s.failed === undefined || s.failed === false, "checkpoint contains a stopped story");
  const frame = s.frames.at(-1);
  if (s.pending.kind === "legacy") {
    check(
      machine.program.functions[frame.function].code[frame.pc - 1]?.op === "legacy_call" &&
        machine.program.functions[frame.function].signature.suspend &&
        s.legacyUsed,
      "invalid legacy input continuation",
    );
    validateLegacyOptions(s.pending.options);
    if (s.pending.input !== undefined) {
      validateInput(s.pending.input);
      check(s.pending.options.length === 0, "invalid native input choices");
    }
    copyJson(s.pending.continuation);
  } else {
    check(
      machine.program.functions[frame.function].code[frame.pc - 1]?.op === "choose",
      "checkpoint has no waiting choice",
    );
    validateOptions(machine, s.pending.options, frame);
    check(
      s.pending.options.some((o) => o.enabled) && JSON.stringify(s.pending.options) === JSON.stringify(frame.choice),
      "invalid choice snapshot",
    );
  }
  check(Array.isArray(s.transcript) && s.transcript.every((x) => typeof x === "string"), "invalid transcript");
  check(
    s.history &&
      typeof s.history === "object" &&
      !Array.isArray(s.history) &&
      Object.values(s.history).every((v) => v === true),
    "invalid once-option history",
  );
}

export function serializeCheckpoint(machine) {
  check(machine.state.pending !== null, "saves require a fully prepared input checkpoint");
  saveLegacyHost(machine);
  const text = JSON.stringify(machine.state, (key, v) =>
    v?.kind === "float" && Object.is(v.value, -0) ? { kind: "float", value: "-0" } : v,
  );
  check(text.length <= 16 * 1024 * 1024, "checkpoint size budget exceeded");
  return text;
}

export function parseCheckpoint(checkpoint) {
  check(typeof checkpoint === "string" && checkpoint.length <= 16 * 1024 * 1024, "checkpoint size budget exceeded");
  try {
    return JSON.parse(checkpoint, (key, item) =>
      item?.kind === "float" && item.value === "-0" ? { kind: "float", value: -0 } : item,
    );
  } catch {
    throw new BifoilError("invalid checkpoint JSON");
  }
}
