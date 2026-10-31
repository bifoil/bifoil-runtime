import { scalarOrder } from "./text.mjs";
// Checked primitive operators. Heap-aware equality and membership live in RuntimeHeap.
import { BifoilError, check } from "./errors.mjs";
import { value, int, float, format, isNumeric as numeric } from "./values.mjs";

export function binary(operator, a, b) {
  if (operator === "===" || operator === "!==") {
    check(a.kind !== "function" && b.kind !== "function", "function equality is unavailable");
    const equal = a.kind === b.kind && a.value === b.value;
    return value("boolean", operator === "===" ? equal : !equal);
  }
  if (operator === "==" || operator === "!=") {
    check((a.kind === b.kind && a.kind !== "function") || (numeric(a) && numeric(b)), "incompatible equality operands");
    const equal = a.value === b.value;
    return value("boolean", operator === "==" ? equal : !equal);
  }
  if (["<", "<=", ">", ">="].includes(operator)) {
    check((numeric(a) && numeric(b)) || (a.kind === "string" && b.kind === "string"), "incompatible ordered operands");
    const order = a.kind === "string" ? scalarOrder(a.value, b.value) : Math.sign(a.value - b.value);
    return value("boolean", { "<": order < 0, "<=": order <= 0, ">": order > 0, ">=": order >= 0 }[operator]);
  }
  if (operator === "+" && (a.kind === "string" || b.kind === "string")) return value("string", format(a) + format(b));
  check(numeric(a) && numeric(b), "numeric operands required");
  if (operator === "%+" || operator === "%-") {
    check(a.value >= 0 && a.value <= 100, "fairmath base must be in 0..100");
    // Pinned ChoiceScript formula, directional rounding, and asymmetric endpoint clamps.
    let modifier = b.value;
    if (operator === "%-") modifier = -modifier;
    if (modifier > 0) return int(Math.min(99, Math.floor(a.value + modifier * ((100 - a.value) / 100))));
    return int(Math.max(1, Math.ceil(a.value - (0 - modifier) * (a.value / 100))));
  }
  if (operator === "/" || operator === "%") check(b.value !== 0, "division by zero");
  let result;
  switch (operator) {
    case "+":
      result = a.value + b.value;
      break;
    case "-":
      result = a.value - b.value;
      break;
    case "*":
      result = a.value * b.value;
      break;
    case "/":
      result = a.value / b.value;
      break;
    case "%":
      check(a.kind === "int" && b.kind === "int", "remainder requires Int operands");
      return int(a.value % b.value);
    default:
      throw new BifoilError("unsupported binary operator " + operator);
  }
  if (a.kind === "int" && b.kind === "int") return int(operator === "/" ? Math.trunc(result) : result);
  return float(result);
}
