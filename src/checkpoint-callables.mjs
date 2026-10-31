// Active calls have already selected all generic arguments. Saved parameter
// cells must retain the exact declared type and mutability of that invocation.
import { BifoilError, check } from "./errors.mjs";
import { validTypeArguments } from "./callable-values.mjs";
import { sameType, substitute } from "./types.mjs";

export function validateFrameCall(machine, frame) {
  const signature = machine.program.functions[frame.function].signature;
  const arguments_ = frame.typeArgs ?? {};
  check(validTypeArguments(frame.typeArgs), "invalid saved call type arguments");
  check(
    (signature.generics ?? []).every((parameter) => Object.hasOwn(arguments_, parameter.name)),
    "missing saved call type argument",
  );
  try {
    // This includes outer method/function parameters used only in the result.
    substitute(machine.functionType(signature), arguments_);
  } catch (error) {
    if (!(error instanceof BifoilError)) throw error;
    check(false, "unresolved saved call type argument");
  }
  for (const parameter of signature.params) {
    const id = machine.cellId(frame.env, parameter.name);
    if (id === null) {
      // A default can itself suspend before installing this parameter.
      check(parameter.default, "missing saved call parameter " + parameter.name);
      continue;
    }
    const cell = machine.state.cells[id];
    const element = substitute(parameter.ty, arguments_);
    const expected = parameter.vararg ? { kind: "named", name: "List", args: [element] } : element;
    check(
      cell.initialized !== false && cell.mutable === parameter.mutable && sameType(cell.ty, expected),
      "invalid saved call parameter " + parameter.name,
    );
  }
}
