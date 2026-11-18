import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";

const value = (kind, value) => ({ kind, value });
const integer = (n) => value("int", n);
const named = (name, ...args) => ({ kind: "named", name, args });
const machine = () => new VM(JSON.parse(readFileSync(new URL("./fixtures/unicode.json", import.meta.url), "utf8")));

test("heap-aware equality, membership negation, and character ordering retain their distinct rules", () => {
  const vm = machine();
  for (const [operator, expected] of [
    ["==", true],
    ["!=", false],
    ["===", false],
    ["!==", true],
  ])
    assert.deepEqual(vm.binary(operator, integer(3), value("float", 3)), value("boolean", expected));
  for (const [left, right] of [
    [value("char", "😀"), value("string", "\ue000")],
    [value("string", "😀"), value("char", "\ue000")],
    [value("char", "😀"), value("char", "\ue000")],
    [integer(3), integer(2)],
  ]) {
    for (const [operator, expected] of [
      ["<", false],
      ["<=", false],
      [">", true],
      [">=", true],
    ])
      assert.deepEqual(vm.binary(operator, left, right), value("boolean", expected));
  }
  const list = vm.collectionValue(named("List", { kind: "int" }), [integer(3), integer(5)]);
  for (const [item, expected] of [
    [3, true],
    [4, false],
  ]) {
    assert.deepEqual(vm.binary("in", integer(item), list), value("boolean", expected));
    assert.deepEqual(vm.binary("!in", integer(item), list), value("boolean", !expected));
  }
});

test("range and text membership reject the wrong value kinds and respect both endpoints", () => {
  const vm = machine();
  const range = { kind: "range", type: named("IntRange"), first: 2, last: 5, step: 1, empty: false };
  for (const [item, expected] of [
    [1, false],
    [2, true],
    [5, true],
    [6, false],
  ])
    assert.equal(vm.contains(range, integer(item)), expected);
  assert.equal(vm.contains(range, value("char", "2")), false);
  const empty = { ...range, type: named("IntProgression"), first: 5, last: 2, empty: true };
  assert.equal(vm.validValue(empty), true);
  assert.equal(vm.contains(empty, integer(5)), false);
  assert.equal(vm.contains(value("string", "a😀"), value("char", "😀")), true);
  assert.equal(vm.contains(value("string", "a😀"), value("char", "z")), false);
  assert.equal(vm.contains(value("string", "a😀"), value("string", "a")), false);
});
