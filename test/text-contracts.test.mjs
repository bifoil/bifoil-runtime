import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeHeap } from "../src/heap.mjs";
import { format, int, float, value, isScalarString } from "../src/values.mjs";
import { stringify } from "../src/rendering.mjs";
import { fromLegacy } from "../src/legacy/values.mjs";

function heap(profile = "bifoil-vm.v3") {
  return Object.assign(new RuntimeHeap(), {
    program: { profile, types: { "example.Mood": { kind: "enum" } } },
    state: { cells: [], objects: [], frames: [] },
  });
}
const named = (name, ...args) => ({ kind: "named", name, args });
const stringType = { kind: "string" };

function record(machine, name, contents, tag = null) {
  const fields = Object.fromEntries(
    Object.entries(contents).map(([field, item]) => [
      field,
      machine.state.cells.push({ initialized: true, mutable: true, ty: machine.valueType(item), value: item }) - 1,
    ]),
  );
  return machine.allocateObject({ kind: "data", type: named(name), fields, tag });
}

test("primitive rendering has stable decimal, exponent, Boolean, and signed-zero spellings", () => {
  const samples = [
    [int(-2147483648), "-2147483648"],
    [int(2147483647), "2147483647"],
    [float(-0), "0"],
    [float(1), "1"],
    [float(0.000001), "0.000001"],
    [float(0.0000001), "1e-7"],
    [float(1e20), "100000000000000000000"],
    [float(1e21), "1e+21"],
    [float(5e-324), "5e-324"],
    [value("boolean", true), "true"],
    [value("boolean", false), "false"],
    [value("char", "😀"), "😀"],
  ];
  const machine = heap();
  for (const [item, expected] of samples) {
    assert.equal(format(item), expected);
    assert.equal(stringify(machine, item), expected);
  }
  assert.equal(Object.is(int(-0).value, 0), true);
  for (const invalid of [NaN, Infinity, -Infinity]) assert.throws(() => float(invalid), /non-finite/);
  assert.throws(() => format(value("null", null)), /not renderable/);
});

test("explicit rendering retains repeated aliases and marks only active ancestor cycles", () => {
  const machine = heap();
  const node = record(machine, "example.Node", { name: value("string", "Ada"), next: value("null", null) });
  machine.state.cells[machine.object(node).fields.next].value = node;
  const list = machine.collectionValue(named("List", named("example.Node")), [node, node]);
  assert.equal(
    stringify(machine, list),
    "[example.Node(name=Ada, next=<cycle>), example.Node(name=Ada, next=<cycle>)]",
  );
  const map = machine.collectionValue(named("Map", stringType, named("example.Node")), [
    [value("string", "key"), node],
  ]);
  assert.equal(stringify(machine, map), "{key: example.Node(name=Ada, next=<cycle>)}");
  const entry = machine.allocateObject({
    kind: "entry",
    type: named("Entry", stringType, named("example.Node")),
    key: value("string", "key"),
    value: node,
  });
  assert.equal(stringify(machine, entry), "key: example.Node(name=Ada, next=<cycle>)");
});

test("current enum conversion retains the case while legacy profiles retain their output", () => {
  for (const profile of ["bifoil-vm.v1", "bifoil-vm.v2", "bifoil-vm.v3"]) {
    const machine = heap(profile);
    const happy = record(machine, "example.Mood", {}, "Happy");
    const sad = record(machine, "example.Mood", {}, "Sad");
    assert.equal(stringify(machine, happy), profile.endsWith("v3") ? "example.Mood.Happy" : "example.Mood()");
    assert.equal(stringify(machine, sad), profile.endsWith("v3") ? "example.Mood.Sad" : "example.Mood()");
  }
});

test("explicit rendering handles deep graphs without consuming the host call stack", () => {
  const machine = heap();
  let item = value("string", "end");
  for (let depth = 0; depth < 12000; depth++) item = record(machine, "example.Link", { next: item });
  const text = stringify(machine, item);
  assert.equal(text, "example.Link(next=".repeat(12000) + "end" + ")".repeat(12000));
});

test("external scalar text rejects isolated surrogates while retaining valid supplementary pairs", () => {
  for (const malformed of ["\ud800", "\udfff", "a\ud800b", "😀\udc00"]) {
    assert.equal(isScalarString(malformed), false);
    assert.throws(() => fromLegacy(malformed, stringType), /Unicode scalar/);
  }
  const valid = "😀e\u0301".repeat(100000);
  assert.equal(fromLegacy(valid, stringType).value, valid);
  assert.equal(isScalarString(valid), true);
});
