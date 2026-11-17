// Instruction envelope checks are shared by complete bodies and lazy summaries.
import { check } from "./errors.mjs";
import { typeValid } from "./types.mjs";
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
  "exact_compare",
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
export function validateInstruction(program, op, length) {
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
    check(Number.isInteger(op.target) && op.target >= 0 && op.target < length, "invalid jump");
  if (op.op === "choose" && op.fallback !== null) {
    check(Number.isInteger(op.fallback) && op.fallback >= 0 && op.fallback < length, "invalid fallback");
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
  if (op.op === "exact_compare") {
    check(program.profile === "bifoil-vm.v3", "exact comparison views require bifoil-vm.v3");
    check(
      typeValid(op.left_type) && typeValid(op.right_type) && typeof op.negate === "boolean",
      "invalid exact comparison views",
    );
  }
  if (op.op === "binary" && ["===", "!=="].includes(op.operator))
    check(program.profile !== "bifoil-vm.v3", "exact equality requires declared comparison views");
}
