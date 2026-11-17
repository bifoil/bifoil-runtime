import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { copyCollection } from "../src/conversions.mjs";
import { typeValid } from "../src/types.mjs";

const named = (name, ...args) => ({ kind: "named", name, args });
const integer = (value) => ({ kind: "int", value });
const intType = { kind: "int" };
const floatType = { kind: "float" };
const optional = (inner) => ({ kind: "nullable", inner });
const fixture = () => new VM(JSON.parse(readFileSync(new URL("./fixtures/unicode.json", import.meta.url), "utf8")));

test("deep collection copies widen nullable leaves and preserve each source layer", () => {
  const machine = fixture();
  let source = machine.collectionValue(named("List", optional(intType)), [integer(7), { kind: "null", value: null }]);
  let target = named("List", optional(floatType));
  for (let depth = 0; depth < 60; depth++) {
    source = machine.collectionValue(named("List", source.type), [source]);
    target = named("List", target);
  }
  target = { ...target, name: "MutableList" };
  assert.equal(typeValid(source.type), true);
  assert.equal(typeValid(target), true);
  let converted = machine.convert(source, target);
  assert.deepEqual(converted.type, target);
  for (let depth = 0; depth < 60; depth++) {
    assert.notEqual(converted.ref, source.ref);
    source = machine.object(source).items[0];
    converted = machine.object(converted).items[0];
  }
  assert.deepEqual(machine.object(converted).items, [
    { kind: "float", value: 7 },
    { kind: "null", value: null },
  ]);
  assert.equal(machine.object(source).items[0].kind, "int");
});

test("projected copies retain concrete covariant arguments and share compatible contained values", () => {
  const machine = fixture();
  const leaf = machine.collectionValue(named("List", intType), [integer(3)]);
  const source = machine.collectionValue(named("MutableList", leaf.type), [leaf, leaf]);
  const copied = machine.convert(source, named("List", named("List", { kind: "star" })));
  assert.deepEqual(copied.type, named("List", named("List", intType)));
  assert.notEqual(copied.ref, source.ref);
  assert.strictEqual(machine.object(copied).items[0], leaf);
  assert.strictEqual(machine.object(copied).items[1], leaf);
  machine.object(source).items.push(leaf);
  assert.equal(machine.object(copied).items.length, 2);
});

test("implicit mutable invariance and explicitly requested fresh copies remain distinct", () => {
  const machine = fixture();
  const source = machine.collectionValue(named("MutableList", intType), [integer(4)]);
  assert.throws(() => machine.convert(source, named("MutableList", floatType)), /mutable type arguments are invariant/);
  const copied = copyCollection(machine, source, named("MutableList", floatType));
  assert.notEqual(copied.ref, source.ref);
  assert.deepEqual(machine.object(copied).items, [{ kind: "float", value: 4 }]);
  const repeated = copyCollection(machine, copied, copied.type);
  assert.notEqual(repeated.ref, copied.ref);
  assert.strictEqual(machine.convert(copied, copied.type), copied);
  assert.equal(machine.object(source).items[0].kind, "int");
});

test("map and set conversions retain insertion order while widening keys, values and elements", () => {
  const machine = fixture();
  const char = { kind: "char" },
    string = { kind: "string" };
  const first = machine.collectionValue(named("List", intType), [integer(2)]);
  const second = machine.collectionValue(named("List", intType), [integer(5)]);
  const source = machine.collectionValue(named("Map", char, first.type), [
    [{ kind: "char", value: "😀" }, first],
    [{ kind: "char", value: "a" }, second],
  ]);
  const converted = machine.convert(source, named("MutableMap", string, named("List", floatType)));
  const entries = machine.object(converted).entries;
  assert.deepEqual(
    entries.map(([key]) => key),
    [
      { kind: "string", value: "😀" },
      { kind: "string", value: "a" },
    ],
  );
  assert.deepEqual(
    entries.map(([, value]) => machine.object(value).items),
    [[{ kind: "float", value: 2 }], [{ kind: "float", value: 5 }]],
  );
  const set = machine.collectionValue(named("Set", char), [
    { kind: "char", value: "😀" },
    { kind: "char", value: "a" },
  ]);
  const copied = machine.convert(set, named("MutableSet", string));
  assert.deepEqual(
    machine.object(copied).items,
    entries.map(([key]) => key),
  );
  const empty = machine.collectionValue(named("Map", char, intType));
  assert.deepEqual(
    machine.convert(empty, named("MutableMap", string, floatType)).type,
    named("MutableMap", string, floatType),
  );
});

test("shallow copies preserve cyclic mutable descendants instead of traversing or freezing them", () => {
  const machine = fixture();
  const source = machine.collectionValue(named("MutableList", optional({ kind: "any" })));
  machine.object(source).items.push(source, source);
  const converted = machine.convert(source, named("List", optional({ kind: "any" })));
  assert.notEqual(converted.ref, source.ref);
  assert.strictEqual(machine.object(converted).items[0], source);
  assert.strictEqual(machine.object(converted).items[1], source);
  machine.object(source).items.push(integer(8));
  assert.equal(machine.object(converted).items.length, 2);
  assert.equal(machine.object(machine.object(converted).items[0]).items.length, 3);
});

test("wide conversion and explicit copies avoid host argument-array limits", () => {
  const machine = fixture();
  const size = 300000;
  const source = machine.collectionValue(
    named("List", intType),
    Array.from({ length: size }, (_, index) => integer(index)),
  );
  const converted = machine.convert(source, named("List", floatType));
  const repeated = copyCollection(machine, converted, converted.type);
  const items = machine.object(repeated).items;
  assert.equal(items.length, size);
  assert.deepEqual(items[0], { kind: "float", value: 0 });
  assert.deepEqual(items.at(-1), { kind: "float", value: size - 1 });
  assert.notEqual(converted.ref, repeated.ref);
  assert.equal(machine.object(source).items.at(-1).kind, "int");
});

test("explicit copies of already-checked composite keys do not repeat structural duplicate searches", () => {
  const machine = fixture();
  const values = Array.from({ length: 2000 }, (_, index) =>
    machine.collectionValue(named("List", intType), [integer(index)]),
  );
  const source = machine.collectionValue(named("Set", named("List", intType)), values);
  machine.equal = () => {
    throw new Error("copy repeated a structural duplicate search");
  };
  const copied = copyCollection(machine, source, source.type);
  assert.notEqual(copied.ref, source.ref);
  assert.equal(machine.object(copied).items.length, values.length);
  assert.strictEqual(machine.object(copied).items[0], values[0]);
  assert.strictEqual(machine.object(copied).items.at(-1), values.at(-1));
});

function nominalKeyMachine() {
  const machine = fixture();
  machine.program.types = {
    "example.Outcome": { parameters: [] },
    "example.Outcome.Success": { parameters: [], parent: "example.Outcome" },
  };
  const key = (number) => {
    const cell = machine.state.cells.length;
    machine.state.cells.push({ value: integer(number) });
    return machine.allocateObject({
      kind: "data",
      type: named("example.Outcome.Success"),
      tag: "Success",
      fields: { number: cell },
    });
  };
  return { machine, key };
}

test("nominal map-key rebuilding checks keys and preserves their retained types and aliases", () => {
  const { machine, key } = nominalKeyMachine();
  const first = key(1),
    second = key(2);
  const source = machine.collectionValue(named("Map", first.type, intType), [
    [first, integer(10)],
    [second, integer(20)],
  ]);
  const equal = machine.equal.bind(machine);
  let comparisons = 0;
  machine.equal = (...arguments_) => {
    comparisons++;
    return equal(...arguments_);
  };
  for (const explicit of [false, true]) {
    comparisons = 0;
    const target = named("Map", named("example.Outcome"), floatType);
    const converted = explicit ? copyCollection(machine, source, target) : machine.convert(source, target);
    assert.notEqual(converted.ref, source.ref);
    assert.deepEqual(converted.type, target);
    const entries = machine.object(converted).entries;
    assert.strictEqual(entries[0][0], first);
    assert.strictEqual(entries[1][0], second);
    assert.equal(entries[0][0].type.name, "example.Outcome.Success");
    assert.deepEqual(
      entries.map(([, value]) => value),
      [
        { kind: "float", value: 10 },
        { kind: "float", value: 20 },
      ],
    );
    assert.ok(comparisons > 0, "changed key types require duplicate checking, including explicit copies");
  }
  assert.equal(machine.object(source).entries[0][1].kind, "int");
});

test("a rebuilt map rejects a duplicate key before attempting that entry's value conversion", () => {
  for (const explicit of [false, true]) {
    const { machine, key } = nominalKeyMachine();
    const first = key(1),
      duplicate = key(1);
    // Exercise the conversion guard directly with an adversarial internal map.
    // The second value would fail conversion if evaluated before its duplicate.
    const source = machine.collectionValue(named("Map", first.type, intType), [
      [first, integer(10)],
      [duplicate, { kind: "string", value: "unreachable" }],
    ]);
    const target = named("Map", named("example.Outcome"), floatType);
    assert.throws(
      () => (explicit ? copyCollection(machine, source, target) : machine.convert(source, target)),
      /conversion produced a duplicate map key/,
    );
  }
});
