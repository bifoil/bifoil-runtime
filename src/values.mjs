import { check } from "./errors.mjs";

export const INT_MIN = -2147483648;
export const INT_MAX = 2147483647;

export function value(kind, contents) {
  return { kind, value: contents };
}

export const unit = () => value("unit", null);
export const nullValue = () => value("null", null);
export const isNumeric = (item) => item.kind === "int" || item.kind === "float";

export function int(number) {
  check(Number.isInteger(number) && number >= INT_MIN && number <= INT_MAX, "Int overflow");
  return value("int", number === 0 ? 0 : number);
}

export function float(number) {
  check(Number.isFinite(number), "non-finite Float result");
  return value("float", number);
}

export function format(item) {
  check(["int", "float", "boolean", "string", "char"].includes(item.kind), "value is not renderable");
  return String(item.value);
}

export function isScalarString(text) {
  if (typeof text !== "string") return false;
  for (const character of text) {
    const scalar = character.codePointAt(0);
    if (scalar >= 0xd800 && scalar <= 0xdfff) return false;
  }
  return true;
}
