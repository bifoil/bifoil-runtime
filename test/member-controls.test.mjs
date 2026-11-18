import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeMembers } from "../src/members.mjs";
import { int, value, unit, nullValue } from "../src/values.mjs";

const type = (kind) => ({ kind });
const named = (name, ...args) => ({ kind: "named", name, args });
const integer = type("int"),
  string = type("string"),
  boolean = type("boolean");
function heap() {
  return Object.assign(new RuntimeMembers(), {
    program: { profile: "bifoil-vm.v3", types: {}, functions: {} },
    state: { cells: [], objects: [], frames: [], prose: [], envs: [{ parent: null, bindings: {} }] },
  });
}
function call(
  machine,
  receiver,
  name,
  args,
  result,
  parameterTypes = args.map((item) => machine.valueType(item)),
  names = args.map(() => null),
) {
  const signature = { kind: "function", params: parameterTypes, result, suspend: false };
  const callable =
    receiver === null
      ? { kind: "builtin", name, receiver: null, type: signature }
      : machine.getMember(receiver, name, signature, "$builtin." + name);
  return machine.invokeBuiltin(callable, args, names, true);
}

test("primitive members and conversions preserve scalar values and reject invalid requests", () => {
  const machine = heap();
  assert.equal(machine.getMember(value("string", "😀x"), "length", integer).value, 2);
  assert.equal(machine.getMember(value("char", "😀"), "code", integer).value, 0x1f600);
  assert.equal(call(machine, int(3), "toFloat", [], type("float")).value, 3);
  assert.equal(call(machine, value("float", -3.9), "toInt", [], integer).value, -3);
  assert.equal(call(machine, value("string", "😀ab"), "substring", [int(1), int(3)], string).value, "ab");
  assert.equal(call(machine, null, "Char", [int(0x1f600)], type("char")).value, "😀");
  assert.equal(call(machine, null, "Float", [int(4)], type("float")).value, 4);
  assert.equal(call(machine, null, "Int", [value("float", -3.9)], integer).value, -3);
  assert.equal(call(machine, null, "String", [nullValue()], string).value, "null");
  for (const code of [-1, 0xd800, 0xdfff, 0x110000])
    assert.throws(() => call(machine, null, "Char", [int(code)], type("char")), /Unicode scalar/);
  assert.throws(() => call(machine, null, "Int", [value("string", "3")], integer), /requires a number/);
  assert.throws(() => call(machine, null, "Float", [value("string", "3")], type("float")), /finite number/);
  assert.throws(() => call(machine, null, "unknown", [], integer), /unknown intrinsic/);
  assert.throws(() => call(machine, value("string", "x"), "toInt", [], integer), /numeric conversion/);
  assert.throws(() => machine.getMember(nullValue(), "length", integer), /null member/);
  assert.throws(() => machine.getMember(int(1), "unknown", integer), /unknown member/);
  assert.throws(() => machine.getMember(int(1), "toString", integer, "$builtin.toString"), /invalid builtin/);
});

test("collection members distinguish empty, missing, immutable, and invalid indexed operations", () => {
  const machine = heap();
  for (const family of ["List", "Set", "Map"]) {
    const args = family === "Map" ? [string, integer] : [integer];
    const receiver = machine.collectionValue(named(family, ...args));
    assert.equal(machine.getMember(receiver, "size", integer).value, 0);
    assert.equal(call(machine, receiver, "isEmpty", [], boolean).value, true);
    assert.throws(() => call(machine, receiver, "clear", [], type("unit")), /mutable container/);
  }
  assert.equal(call(machine, value("string", ""), "isEmpty", [], boolean).value, true);
  assert.equal(call(machine, value("string", "x"), "isEmpty", [], boolean).value, false);
  const list = machine.collectionValue(named("MutableList", integer), [int(1)]);
  const address = { kind: "address", ref: list.ref, key: int(0) };
  assert.equal(machine.readAddress(address).value, 1);
  machine.writeAddress(address, int(7));
  assert.equal(machine.getIndex(list, int(0)).value, 7);
  assert.throws(() => machine.writeAddress(address, value("string", "bad")), /type mismatch/);
  for (const key of [int(-1), int(1), value("float", 0)])
    assert.throws(() => machine.getIndex(list, key), /index out of bounds/);
  assert.throws(() => machine.getIndex(value("string", "x"), value("string", "0")), /index out of bounds/);
  assert.throws(() => machine.getIndex(machine.collectionValue(named("Set", integer)), int(0)), /cannot be indexed/);
  assert.throws(() => machine.readAddress(unit()), /invalid assignment address/);
  assert.throws(() => machine.writeAddress(unit(), int(1)), /invalid assignment address/);
  const immutable = machine.collectionValue(named("List", integer), [int(1)]);
  assert.throws(() => machine.writeAddress({ ...address, ref: immutable.ref }, int(2)), /immutable collection/);
  assert.throws(() => call(machine, list, "add", [int(2), int(3)], boolean, [integer]), /invalid builtin argument/);
  assert.throws(() => call(machine, list, "add", [], boolean, [integer]), /missing builtin argument/);
  assert.throws(
    () => call(machine, list, "put", [int(1)], integer, [integer], ["unknown"]),
    /invalid builtin argument/,
  );
});

test("entry fields, range properties and data updates retain their distinct checked contracts", () => {
  const machine = heap();
  const entry = machine.allocateObject({
    kind: "entry",
    type: named("Entry", string, integer),
    key: value("string", "a"),
    value: int(2),
  });
  assert.equal(machine.getMember(entry, "key", string).value, "a");
  assert.equal(machine.getMember(entry, "value", integer).value, 2);
  const range = { kind: "range", type: named("IntRange"), first: 2, last: 5, step: 1, empty: false };
  for (const [name, expected] of [
    ["first", 2],
    ["last", 5],
    ["step", 1],
  ])
    assert.equal(machine.getMember(range, name, integer).value, expected);
  const cell = machine.state.cells.push({ ty: integer, mutable: true, initialized: true, value: int(3) }) - 1;
  machine.program.types.Counter = {
    kind: "data",
    parameters: [],
    fields: { count: { ty: integer, mutable: true } },
    methods: {},
  };
  const counter = machine.allocateObject({ kind: "data", type: named("Counter"), fields: { count: cell } });
  const address = { kind: "address", ref: counter.ref, key: value("string", "count") };
  assert.equal(machine.readAddress(address).value, 3);
  machine.writeAddress(address, int(4));
  assert.equal(machine.getMember(counter, "count", integer).value, 4);
  assert.throws(() => machine.readAddress({ ...address, key: value("string", "absent") }), /unknown field/);
  machine.state.cells[cell].mutable = false;
  assert.throws(() => machine.writeAddress(address, int(5)), /invalid field update/);
  assert.throws(
    () => machine.getMember(counter, "unknown", { kind: "function", params: [], result: integer, suspend: false }),
    /unknown or ambiguous/,
  );
});

test("diagnostic rendering prints containers, entries, enums and cycles without confusing aliases", () => {
  const machine = heap();
  const items = machine.collectionValue(named("MutableList", integer), [int(1), int(2)]);
  const mapping = machine.collectionValue(named("Map", string, integer), [
    [value("string", "a"), int(1)],
    [value("string", "b"), int(2)],
  ]);
  assert.equal(machine.stringify(items), "[1, 2]");
  assert.equal(machine.stringify(mapping), "{a: 1, b: 2}");
  const entry = machine.allocateObject({
    kind: "entry",
    type: named("Entry", string, integer),
    key: value("string", "a"),
    value: int(1),
  });
  assert.equal(machine.stringify(entry), "a: 1");
  machine.object(items).items.push(items);
  assert.match(machine.stringify(items), /cycle/);
  machine.program.types.Mood = { kind: "enum" };
  const mood = machine.allocateObject({ kind: "data", type: named("Mood"), fields: {}, tag: "Happy" });
  assert.equal(machine.stringify(mood), "Mood.Happy");
});

test("legacy singleton methods retain implicit receivers and reject ambiguous overload selection", () => {
  const machine = heap();
  const signature = { id: "Counter.read", params: [], result: integer, suspend: false, scene: false };
  machine.program.functions[signature.id] = { signature, init: false, local: false, code: [] };
  // Earlier nongeneric definitions need neither a parameter list nor an overload array.
  machine.program.types.Counter = { kind: "data", fields: {}, methods: { read: signature } };
  const receiver = machine.allocateObject({ kind: "data", type: named("Counter"), fields: {} });
  const type = { kind: "function", params: [], result: integer, suspend: false };
  const selected = machine.getMember(receiver, "read", type);
  assert.equal(selected.id, signature.id);
  assert.deepEqual(selected.typeArgs, {});
  machine.pushCall(selected, [], [], { direct: false });
  assert.equal(machine.cell(machine.state.frames.at(-1).env, "this").value.ref, receiver.ref);
  assert.throws(() => machine.pushCall(selected, [int(1)], ["absent"], { direct: true }), /unknown or duplicate/);
  const second = { ...signature, id: "Counter.other", params: [{ name: "amount", ty: integer }] };
  machine.program.types.Counter.methods.read = [signature, second];
  assert.throws(() => machine.getMember(receiver, "read", type), /ambiguous/);
  assert.equal(machine.getMember(receiver, "read", type, signature.id).id, signature.id);
});

test("member stringification and collection membership preserve checked method dispatch", () => {
  const machine = heap();
  assert.equal(call(machine, int(7), "toString", [], string).value, "7");
  const list = machine.collectionValue(named("MutableList", integer), [int(7)]);
  assert.equal(call(machine, list, "contains", [int(7)], boolean).value, true);
  assert.equal(call(machine, list, "contains", [int(8)], boolean).value, false);
  assert.throws(() => call(machine, list, "unrecognized", [], type("unit")), /unknown builtin method/);
});

test("indexed map assignments replace a present value without adding another key", () => {
  const machine = heap();
  const mapping = machine.collectionValue(named("MutableMap", string, integer), [
    [value("string", "original"), int(1)],
  ]);
  const address = { kind: "address", ref: mapping.ref, key: value("string", "original") };
  machine.writeAddress(address, int(2));
  assert.equal(machine.readAddress(address).value, 2);
  assert.equal(machine.object(mapping).entries.length, 1);
});
