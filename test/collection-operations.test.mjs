import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeMembers } from "../src/members.mjs";
import { int, value } from "../src/values.mjs";

const named = (name, ...args) => ({ kind: "named", name, args });
const intType = { kind: "int" },
  stringType = { kind: "string" },
  booleanType = { kind: "boolean" };
const nullable = (inner) => ({ kind: "nullable", inner });
const text = (input) => value("string", input);
function heap(profile = "bifoil-vm.v3") {
  return Object.assign(new RuntimeMembers(), {
    program: { profile, types: {} },
    state: { cells: [], objects: [], frames: [] },
  });
}
function method(machine, receiver, name, params, result) {
  return machine.getMember(receiver, name, { kind: "function", params, result, suspend: false }, "$builtin." + name);
}
function call(machine, receiver, name, args, result, names = args.map(() => null)) {
  const callable = method(
    machine,
    receiver,
    name,
    args.map((arg) => machine.valueType(arg)),
    result,
  );
  return machine.invokeBuiltin(callable, args, names, true);
}

test("current named map keys and earlier compiled element names retain their checked interfaces", () => {
  for (const profile of ["bifoil-vm.v1", "bifoil-vm.v2", "bifoil-vm.v3"]) {
    const machine = heap(profile);
    const mapping = machine.collectionValue(named("Map", stringType, nullable(intType)), [
      [text("present"), value("null", null)],
    ]);
    const callable = method(machine, mapping, "containsKey", [stringType], booleanType);
    assert.equal(machine.invokeBuiltin(callable, [text("present")], ["element"], true).value, true);
    assert.equal(machine.invokeBuiltin(callable, [text("absent")], [null], false).value, false);
    if (profile.endsWith("v3"))
      assert.equal(machine.invokeBuiltin(callable, [text("present")], ["key"], true).value, true);
    else
      assert.throws(
        () => machine.invokeBuiltin(callable, [text("present")], ["key"], true),
        /invalid builtin argument/,
      );
    assert.throws(() => machine.invokeBuiltin(callable, [text("present")], ["element"], false), /positional/);
    assert.throws(() => machine.invokeBuiltin(callable, [int(1)], [null], true), /type mismatch/);
    assert.throws(
      () => machine.invokeBuiltin(callable, [text("present")], ["unknown"], true),
      /invalid builtin argument/,
    );
  }
});

test("list and set updates return their selected results and retain first-match and insertion order", () => {
  const machine = heap();
  const list = machine.collectionValue(named("MutableList", intType), [int(1), int(2), int(1)]);
  assert.equal(call(machine, list, "add", [int(3)], booleanType).value, true);
  assert.equal(call(machine, list, "remove", [int(1)], booleanType).value, true);
  assert.equal(call(machine, list, "insert", [int(1), int(7)], { kind: "unit" }).kind, "unit");
  assert.equal(call(machine, list, "removeAt", [int(2)], intType).value, 1);
  assert.deepEqual(
    machine.object(list).items.map((item) => item.value),
    [2, 7, 3],
  );
  const members = machine.collectionValue(named("MutableSet", intType), [int(2), int(1)]);
  assert.equal(call(machine, members, "add", [int(2)], booleanType).value, false);
  assert.equal(call(machine, members, "add", [int(3)], booleanType).value, true);
  assert.equal(call(machine, members, "remove", [int(1)], booleanType).value, true);
  assert.equal(call(machine, members, "remove", [int(8)], booleanType).value, false);
  assert.deepEqual(
    machine.object(members).items.map((item) => item.value),
    [2, 3],
  );
});

test("map updates distinguish previous values from key presence and preserve replacement positions", () => {
  const machine = heap();
  const mapping = machine.collectionValue(named("MutableMap", stringType, nullable(intType)), [
    [text("a"), value("null", null)],
    [text("b"), int(2)],
  ]);
  assert.equal(call(machine, mapping, "put", [text("a"), int(3)], nullable(intType)).kind, "null");
  assert.equal(call(machine, mapping, "put", [text("b"), int(4)], nullable(intType)).value, 2);
  assert.deepEqual(
    machine.object(mapping).entries.map(([key]) => key.value),
    ["a", "b"],
  );
  assert.equal(call(machine, mapping, "remove", [text("a")], nullable(intType)).value, 3);
  assert.equal(call(machine, mapping, "remove", [text("missing")], nullable(intType)).kind, "null");
  assert.equal(call(machine, mapping, "put", [text("a"), int(9)], nullable(intType)).kind, "null");
  assert.deepEqual(
    machine.object(mapping).entries.map(([key]) => key.value),
    ["b", "a"],
  );
  assert.equal(call(machine, mapping, "clear", [], { kind: "unit" }).kind, "unit");
  assert.equal(call(machine, mapping, "isEmpty", [], booleanType).value, true);
});

test("explicit container copies detach storage while preserving nested references", () => {
  const machine = heap();
  const inner = machine.collectionValue(named("MutableList", intType), [int(1)]);
  const type = named("MutableList", named("MutableList", intType));
  const source = machine.collectionValue(type, [inner]);
  const copied = call(machine, source, "toMutableList", [], type);
  assert.notEqual(copied.ref, source.ref);
  call(machine, inner, "add", [int(2)], booleanType);
  assert.equal(machine.object(machine.object(copied).items[0]).items.length, 2);
  call(machine, source, "clear", [], { kind: "unit" });
  assert.equal(machine.object(copied).items.length, 1);
});
