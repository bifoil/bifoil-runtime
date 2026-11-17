import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeMembers } from "../src/members.mjs";
import { int, value, nullValue, unit } from "../src/values.mjs";

const integer = { kind: "int" };
const named = (name, ...args) => ({ kind: "named", name, args });
function heap() {
  return Object.assign(new RuntimeMembers(), {
    program: { profile: "bifoil-vm.v3", types: {}, functions: {} },
    state: { cells: [], objects: [], frames: [], envs: [{ parent: null, bindings: {} }] },
  });
}

test("serialized primitives reject malformed values and conflicting type metadata", () => {
  const machine = heap();
  for (const valid of [
    int(-2147483648),
    int(2147483647),
    value("float", -0),
    value("boolean", false),
    value("string", "😀"),
    value("char", "😀"),
    unit(),
    nullValue(),
  ])
    assert.equal(machine.validValue(valid), true);
  for (const invalid of [
    null,
    1,
    {},
    value("int", 2147483648),
    value("int", -2147483649),
    value("int", 0.5),
    value("float", Infinity),
    value("float", NaN),
    value("boolean", 0),
    value("string", "\ud800"),
    value("char", "ab"),
    { kind: "unit", value: 0 },
    { kind: "null", value: "null" },
    { ...int(1), type: { kind: "string" } },
  ])
    assert.equal(machine.validValue(invalid), false, JSON.stringify(invalid));
});

test("saved progressions validate integer bounds, direction, reachability and range identity", () => {
  const machine = heap();
  const range = { kind: "range", type: named("IntProgression"), first: 1, last: 5, step: 2, empty: false };
  assert.equal(machine.validValue(range), true);
  assert.equal(machine.validValue({ ...range, first: 5, last: 1, step: -2 }), true);
  assert.equal(machine.validValue({ ...range, first: 5, last: 1, empty: true }), true);
  assert.equal(machine.validValue({ ...range, type: named("IntRange"), step: 1 }), true);
  const patches = [
    { type: undefined },
    { type: integer },
    { type: named("Other") },
    { type: named("IntProgression", integer) },
    { type: { kind: "named", name: "IntRange" } },
    { empty: 0 },
    { first: 1.5 },
    { last: 5.5 },
    { step: 0.5 },
    { step: 0 },
    { step: -2147483648 },
    { step: 2147483648 },
    { first: -2147483649 },
    { last: 2147483648 },
    { empty: true },
    { last: 4 },
    { type: named("IntRange") },
    { type: named("IntRange"), first: 5, last: 1, step: 1, empty: true },
  ];
  for (const patch of patches) assert.equal(machine.validValue({ ...range, ...patch }), false, JSON.stringify(patch));
});

test("object, callable and assignment references require existing compatible heap slots", () => {
  const machine = heap();
  const list = machine.collectionValue(named("List", integer), [int(1)]);
  assert.equal(machine.validValue(list), true);
  for (const patch of [
    { ref: -1 },
    { ref: 0.5 },
    { ref: 1 },
    { kind: "set" },
    { type: named("List", { kind: "string" }) },
  ])
    assert.equal(machine.validValue({ ...list, ...patch }), false);
  const type = { kind: "function", params: [], result: integer, suspend: false };
  const builtin = { kind: "builtin", name: "Int", receiver: null, type };
  assert.equal(machine.validValue(builtin), true);
  machine.state.cells.push({ ty: integer, mutable: false, initialized: true, value: int(1) });
  assert.equal(machine.validValue({ ...builtin, receiver: 0 }), true);
  for (const patch of [
    { name: 0 },
    { type: null },
    { type: integer },
    { receiver: -1 },
    { receiver: 1 },
    { receiver: 0.5 },
  ])
    assert.equal(machine.validValue({ ...builtin, ...patch }), false);
  const address = { kind: "address", ref: list.ref, key: int(0) };
  assert.equal(machine.validValue(address), true);
  for (const patch of [
    { ref: -1 },
    { ref: 0.5 },
    { ref: 1 },
    { key: address },
    { key: value("int", 0.5) },
    { key: undefined },
  ])
    assert.equal(machine.validValue({ ...address, ...patch }), false);
  assert.throws(() => machine.object({ ...list, ref: 2 }), /invalid object reference/);
  assert.throws(() => machine.collectionValue(named("List")), /invalid collection type/);
  assert.throws(() => machine.collectionValue(integer), /invalid collection type/);
});

test("captures share initialized bindings and reject unknown names and exhausted heap budgets", () => {
  const machine = heap();
  machine.declareCell(0, "score", integer, true, int(1));
  const captured = machine.captureEnvironment(0, ["score"]);
  assert.equal(machine.cell(captured, "score"), machine.cell(0, "score"));
  assert.equal(machine.captureEnvironment(0, []), 0);
  assert.equal(machine.captureEnvironment(captured, undefined), captured);
  assert.throws(() => machine.captureEnvironment(0, ["unknown"]), /unknown captured binding/);
  assert.throws(() => machine.cell(0, "unknown"), /unknown binding/);
  assert.throws(() => machine.declareCell(0, "score", integer, true, int(1)), /duplicate runtime binding/);
  assert.throws(() => machine.declareCell(0, "wrong", integer, true, value("string", "x")), /binding type mismatch/);
  machine.state.envs.length = 100000;
  assert.throws(() => machine.environment(0), /environment budget/);
  machine.state.objects.length = 100000;
  assert.throws(() => machine.collectionValue(named("List", integer)), /object budget/);
});
