import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeMembers } from "../src/members.mjs";
import { boundaryType, fromLegacy, toLegacy } from "../src/legacy/values.mjs";
import { validFunctionValue } from "../src/callable-values.mjs";
import { ComparisonViews } from "../src/comparison-views.mjs";
import { int, value, unit, nullValue } from "../src/values.mjs";
const integer = { kind: "int" },
  string = { kind: "string" };
const named = (name, ...args) => ({ kind: "named", name, args });
function heap() {
  return Object.assign(new RuntimeMembers(), {
    program: { profile: "bifoil-vm.v3", types: {}, functions: {} },
    state: { cells: [], objects: [], frames: [], envs: [{ parent: null, bindings: {} }] },
  });
}
const mood = () => ({ kind: "enum", parameters: [], parent: null, fields: {}, variants: ["Mood.Happy", "Mood.Sad"] });

test("legacy primitive boundaries reject host coercion and invalid scalar data", () => {
  const machine = heap();
  for (const [raw, type, expression] of [
    ["1", integer, /Int/],
    ["1", { kind: "float" }, /Float/],
    [1, { kind: "boolean" }, /Boolean/],
    ["ab", { kind: "char" }, /Char/],
    ["\ud800", string, /Unicode/],
  ])
    assert.throws(() => fromLegacy(raw, type, machine), expression);
  assert.equal(fromLegacy("ignored", { kind: "unit" }).kind, "unit");
  assert.throws(() => fromLegacy(1, { kind: "any" }), /unsupported legacy boundary/);
  assert.throws(() => toLegacy(value("string", "1"), integer), /argument type mismatch/);
  assert.equal(boundaryType({ kind: "unit" }, false), false);
  assert.equal(boundaryType({ kind: "unit" }, true), true);
  assert.equal(boundaryType({ kind: "nullable", inner: { kind: "unit" } }, true), false);
});

test("native enum boundaries validate declarations and reject counterfeit variant objects", () => {
  const machine = heap();
  for (const patch of [
    { kind: "data" },
    { parameters: ["T"] },
    { parameters: {} },
    { parent: "Other" },
    { fields: null },
    { fields: [] },
    { fields: { count: integer } },
    { variants: null },
    { variants: [null] },
    { variants: ["Other.Happy"] },
    { variants: ["Mood."] },
    { variants: ["Mood.\ud800"] },
    { variants: ["Mood.Happy", "Mood.Happy"] },
  ]) {
    const definition = { ...mood(), ...patch };
    assert.equal(boundaryType(named("Mood"), false, { Mood: definition }), false, JSON.stringify(patch));
  }
  const definition = mood();
  assert.equal(boundaryType(named("Mood", integer), false, { Mood: definition }), false);
  assert.equal(boundaryType(named("Mood"), false, { Mood: definition }), true);
  assert.equal(
    boundaryType(named("Other"), false, { Other: definition }),
    false,
    "cached enum identity cannot be relabeled",
  );
  machine.program.types.Mood = mood();
  const type = named("Mood");
  const good = fromLegacy("Happy", type, machine);
  assert.equal(toLegacy(good, type, machine), "Happy");
  assert.throws(() => fromLegacy("Unknown", type, machine), /enum case/);
  assert.throws(() => toLegacy(int(1), type, machine), /enum argument type mismatch/);
  const object = machine.object(good);
  for (const patch of [{ fields: { illegal: 0 } }, { fields: [] }, { tag: "Unknown" }, { tag: "\ud800" }]) {
    Object.assign(object, patch);
    assert.throws(() => toLegacy(good, type, machine), /enum argument type mismatch/);
    Object.assign(object, { fields: {}, tag: "Happy" });
  }
});

test("callable admission rejects invalid environments, receivers and incompatible exposed signatures", () => {
  const machine = heap();
  const signature = { id: "f", params: [], result: integer, suspend: false, scene: false };
  machine.program.functions.f = { signature };
  const callable = { kind: "function", id: "f", env: 0 };
  assert.equal(validFunctionValue(machine, callable), true);
  for (const patch of [
    { id: 0 },
    { id: "missing" },
    { kind: "scene" },
    { env: -1 },
    { env: 0.5 },
    { env: 1 },
    { receiver: -1 },
    { receiver: 0.5 },
    { receiver: 0 },
    { typeArgs: null },
    { typeArgs: [] },
    { typeArgs: { T: {} } },
    { type: {} },
    { type: integer },
    { type: { kind: "function", params: [], result: string, suspend: false } },
  ])
    assert.equal(validFunctionValue(machine, { ...callable, ...patch }), false, JSON.stringify(patch));
});

test("diagnostic rendering distinguishes all callable, scalar and range forms", () => {
  const machine = heap();
  for (const [input, expected] of [
    [unit(), "Unit"],
    [nullValue(), "null"],
    [{ kind: "function", id: "f" }, "<function>"],
    [{ kind: "builtin", name: "Int" }, "<function>"],
    [{ kind: "scene", id: "forest" }, "forest"],
    [{ kind: "range", first: 5, last: 1, step: -1 }, "5 downTo 1"],
    [{ kind: "range", first: 1, last: 5, step: 2 }, "1..5 step 2"],
    [machine.collectionValue(named("Set", integer), [int(1), int(2)]), "{1, 2}"],
  ])
    assert.equal(machine.stringify(input), expected);
  machine.program.types.Pair = { kind: "data" };
  const fields = {};
  for (const [name, input] of [
    ["left", int(1)],
    ["right", int(2)],
  ])
    fields[name] = machine.state.cells.push({ ty: integer, initialized: true, mutable: false, value: input }) - 1;
  const pair = machine.allocateObject({ kind: "data", type: named("Pair"), fields });
  assert.equal(machine.stringify(pair), "Pair(left=1, right=2)");
});

test("exact entry and range equality preserves values and declared child comparison views", () => {
  const machine = heap();
  const type = named("Entry", integer, string);
  const make = (number, text) =>
    machine.allocateObject({ kind: "entry", type, key: int(number), value: value("string", text) });
  assert.equal(machine.exactCompare(make(1, "a"), make(1, "a"), type, type), true);
  assert.equal(machine.exactCompare(make(1, "a"), make(2, "a"), type, type), false);
  assert.equal(machine.exactCompare(make(1, "a"), make(1, "b"), type, type), false);
  assert.equal(machine.equal({ kind: "scene", id: "a" }, { kind: "scene", id: "b" }), false);
  const range = { kind: "range", type: named("IntProgression"), first: 5, last: 1, step: -2, empty: false };
  assert.equal(machine.equal(range, { ...range }), true);
  for (const patch of [{ first: 6 }, { last: 2 }, { step: -1 }])
    assert.equal(machine.equal(range, { ...range, ...patch }), false);
  assert.equal(machine.equal({ ...range, empty: true }, { ...range, first: 8, empty: true }), true);
  const views = new ComparisonViews(machine);
  assert.equal(views.child(integer, { kind: "list" }, "item"), undefined);
  for (const kind of ["function", "scene"]) {
    const signature = { kind, params: [integer], ...(kind === "function" ? { result: integer, suspend: false } : {}) };
    assert.equal(views.identity(signature), views.identity(structuredClone(signature)));
  }
});
