import { validateInstruction } from "./program-instructions.mjs";
// Continuation/capture summaries are sufficient for restoration without bodies.
// A fetched module must reproduce every declared summary before it is installed.
import { check } from "./errors.mjs";
import { record } from "./package-format.mjs";

export function summarizeFunction(fn, module) {
  const continuations = Object.create(null),
    captures = [];
  fn.code.forEach((instruction, index) => {
    if (["choose", "legacy_call", "stack_mark"].includes(instruction.op)) continuations[index] = instruction;
    if (instruction.op === "closure") captures.push(instruction);
  });
  return {
    module,
    signature: fn.signature,
    init: fn.init,
    local: fn.local ?? fn.signature.id.includes("$"),
    instructions: fn.code.length,
    continuations,
    captures,
  };
}

// Metadata arrives as JSON, but compare object members independently of their
// serialization order. The work stack also avoids recursive host-call limits.
export function sameMetadata(first, second) {
  const pending = [[first, second]];
  while (pending.length) {
    const [left, right] = pending.pop();
    if (left === right) continue;
    if (
      !left ||
      !right ||
      typeof left !== "object" ||
      typeof right !== "object" ||
      Array.isArray(left) !== Array.isArray(right)
    )
      return false;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(right, key)) return false;
      pending.push([left[key], right[key]]);
    }
  }
  return true;
}

export function validateCodeMetadata(header, functions) {
  check(
    record(header) &&
      typeof header.module === "string" &&
      typeof header.init === "boolean" &&
      typeof header.local === "boolean" &&
      Number.isSafeInteger(header.instructions) &&
      header.instructions > 0 &&
      record(header.continuations) &&
      Array.isArray(header.captures),
    "invalid lazy function metadata",
  );
  for (const [position, instruction] of Object.entries(header.continuations)) {
    check(
      /^(0|[1-9][0-9]*)$/.test(position) &&
        Number(position) < header.instructions &&
        record(instruction) &&
        ["choose", "legacy_call", "stack_mark"].includes(instruction.op),
      "invalid continuation metadata",
    );
    validateInstruction({ functions }, instruction, header.instructions);
    if (instruction.op === "stack_mark")
      check(Number.isSafeInteger(instruction.id) && instruction.id >= 0, "invalid loop-mark metadata");
  }
  check(header.captures.length <= header.instructions, "invalid capture metadata count");
  for (const instruction of header.captures) {
    check(record(instruction) && instruction.op === "closure", "invalid capture metadata");
    validateInstruction({ functions }, instruction, header.instructions);
  }
}
