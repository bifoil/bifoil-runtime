// Scalar-based text operations over UTF-16 storage without character arrays.
// Inputs have already passed the primitive String validation boundary.
import { check } from "./errors.mjs";

export function isSingleScalar(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  const point = text.codePointAt(0);
  return (point < 0xd800 || point > 0xdfff) && text.length === (point > 0xffff ? 2 : 1);
}
export function scalarLength(text) {
  let count = 0;
  for (const character of text) count++;
  return count;
}
export function scalarAt(text, index) {
  check(Number.isInteger(index) && index >= 0, "index out of bounds");
  let position = 0;
  for (const character of text) if (position++ === index) return character;
  check(false, "index out of bounds");
}
export function scalarSubstring(text, start, end) {
  check(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end, "invalid substring bounds");
  let position = 0,
    offset = 0,
    first = start === 0 ? 0 : null,
    last = end === 0 ? 0 : null;
  for (const character of text) {
    if (last !== null) break;
    offset += character.length;
    position++;
    if (position === start) first = offset;
    if (position === end) last = offset;
  }
  check(first !== null && last !== null, "index out of bounds");
  return text.slice(first, last);
}
export function scalarOrder(left, right) {
  let a = 0,
    b = 0;
  while (a < left.length && b < right.length) {
    const first = left.codePointAt(a),
      second = right.codePointAt(b);
    if (first !== second) return first < second ? -1 : 1;
    a += first > 0xffff ? 2 : 1;
    b += second > 0xffff ? 2 : 1;
  }
  return a < left.length ? 1 : b < right.length ? -1 : 0;
}
export function validScalarOffset(text, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
  const unit = text.charCodeAt(offset);
  return !(unit >= 0xdc00 && unit <= 0xdfff);
}
