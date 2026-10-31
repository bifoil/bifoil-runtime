import { rootFunction } from "./functions.mjs";
import { validateLegacyProgram } from "./legacy.mjs";
// Validate the compiled instruction envelope before creating execution state.
import { check } from "./errors.mjs";
import { typeValid, sameType } from "./types.mjs";
import { MAX_FUNCTIONS, MAX_INSTRUCTIONS } from "./program-limits.mjs";

export const PROFILE = "bifoil-vm.v2";
const OWN = (object, key) => Object.hasOwn(object, key);
const OPERATIONS = new Set([
  "unreachable",
  "legacy_call",
  "constant",
  "load",
  "declare",
  "store",
  "closure",
  "pop",
  "dup",
  "widen",
  "unary",
  "binary",
  "jump",
  "jump_false",
  "jump_true",
  "enter",
  "exit",
  "default",
  "call",
  "return",
  "format",
  "print",
  "begin_choice",
  "offer",
  "choose",
  "convert",
  "member",
  "index",
  "assert_present",
  "type_test",
  "cast",
  "jump_null",
  "begin_collection",
  "collection_add",
  "check_key",
  "collection_put",
  "address_member",
  "address_index",
  "read_address",
  "write_address",
  "range",
  "range_step",
  "iter_start",
  "iter_next",
  "iter_end",
  "stack_mark",
  "stack_reset",
  "stack_end",
  "unwind",
  "unused",
  "scene_call",
  "specialize",
  "construct",
  "uninitialized",
  "function_value",
  "prose_start",
  "prose_text",
  "prose_flush",
  "prose_end",
  "prose_unwind",
]);
export function validateProgram(program) {
  check(
    program &&
      ["bifoil.program.v1", "bifoil.program.v2"].includes(program.format) &&
      ["bifoil-vm.v1", PROFILE].includes(program.profile),
    "unsupported program format/profile",
  );
  check(typeof program.build === "string" && /^[0-9a-f]{64}$/.test(program.build), "invalid build identity");
  check(program.functions && typeof program.functions === "object", "missing functions");
  const functionIds = Object.keys(program.functions);
  check(functionIds.length > 0 && functionIds.length <= MAX_FUNCTIONS, "function budget exceeded");
  let count = 0;
  for (const id of functionIds) {
    const fn = program.functions[id];
    const sig = fn.signature;
    check(
      sig &&
        sig.id === id &&
        Array.isArray(sig.params) &&
        typeValid(sig.result) &&
        typeof sig.suspend === "boolean" &&
        typeof sig.scene === "boolean",
      "invalid function signature",
    );
    check(
      sig.params.every(
        (p, index) =>
          p &&
          typeof p.name === "string" &&
          p.name.length > 0 &&
          typeValid(p.ty) &&
          typeof p.mutable === "boolean" &&
          typeof p.default === "boolean" &&
          (p.vararg === undefined || typeof p.vararg === "boolean") &&
          (!p.vararg || (index + 1 === sig.params.length && !p.default)),
      ),
      "invalid parameters",
    );
    check(new Set(sig.params.map((p) => p.name)).size === sig.params.length, "duplicate parameters");
    check(Array.isArray(fn.code) && fn.code.length > 0, "invalid function body");
    count += fn.code.length;
    check(count <= MAX_INSTRUCTIONS, "instruction budget exceeded");
    for (const op of fn.code) {
      check(
        op &&
          OPERATIONS.has(op.op) &&
          op.span &&
          typeof op.span.file === "string" &&
          Number.isInteger(op.span.line) &&
          op.span.line > 0,
        "invalid instruction",
      );
      if (OWN(op, "target") && op.op !== "legacy_call")
        check(Number.isInteger(op.target) && op.target >= 0 && op.target < fn.code.length, "invalid jump");
      if (op.op === "choose" && op.fallback !== null) {
        check(Number.isInteger(op.fallback) && op.fallback >= 0 && op.fallback < fn.code.length, "invalid fallback");
      }
      if (op.op === "closure" || op.op === "function_value")
        check(OWN(program.functions, op.function), "unknown closure target");
      if ((op.op === "closure" || op.op === "function_value") && op.captures !== undefined)
        check(
          Array.isArray(op.captures) &&
            op.captures.length <= 100000 &&
            op.captures.every((name) => typeof name === "string" && name.length > 0) &&
            new Set(op.captures).size === op.captures.length,
          "invalid closure capture names",
        );
      if (op.op === "constant" || op.op === "declare") check(typeValid(op.ty), "invalid instruction type");
    }
  }
  check(
    program.shared === undefined ||
      (program.shared && typeof program.shared === "object" && !Array.isArray(program.shared)),
    "invalid shared definitions",
  );
  for (const [name, definition] of Object.entries(program.shared ?? {})) {
    check(!rootFunction(program, name), "shared state conflicts with a function binding");
    const initializer = program.functions[definition?.initializer]?.signature;
    check(
      typeof name === "string" &&
        typeValid(definition?.ty) &&
        typeof definition.mutable === "boolean" &&
        Number.isInteger(definition.order) &&
        definition.order >= 0 &&
        Array.isArray(definition.dependencies) &&
        definition.dependencies.every((id) => typeof id === "string" && OWN(program.shared, id)) &&
        initializer &&
        initializer.params.length === 0 &&
        !initializer.suspend &&
        !initializer.scene &&
        sameType(initializer.result, definition.ty),
      "invalid shared initializer",
    );
  }
  if (Object.keys(program.shared ?? {}).length || program.shared_order !== undefined) {
    check(Array.isArray(program.shared_order), "missing shared initialization order");
    const initialized = new Set();
    for (const id of program.shared_order) {
      const definition = program.shared?.[id];
      check(definition && !initialized.has(id), "invalid shared initialization order");
      check(
        definition.dependencies.every((dependency) => initialized.has(dependency)),
        "unordered shared dependency",
      );
      initialized.add(id);
    }
    check(initialized.size === Object.keys(program.shared ?? {}).length, "incomplete shared initialization order");
  }
  check(
    OWN(program.functions, program.entry) && program.functions[program.entry].signature.scene,
    "invalid scene entry",
  );
  check(
    Array.isArray(program.init) && program.init.every((id) => OWN(program.functions, id) && program.functions[id].init),
    "invalid initialization order",
  );
  validateLegacyProgram(program);
  return program;
}
