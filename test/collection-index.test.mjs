import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { collectGarbage } from "../src/collector.mjs";
import { executeInstruction } from "../src/operations.mjs";

const type = (name, args = []) => ({ kind: "named", name, args });
const intType = { kind: "int" };
const integer = (value) => ({ kind: "int", value });
function machine() {
  return new VM(JSON.parse(readFileSync(new URL("./fixtures/unicode.json", import.meta.url), "utf8")));
}
function method(vm, receiver, name, argument) {
  const result = name === "remove" ? { kind: "nullable", inner: intType } : { kind: "unit" };
  const parameters = name === "clear" ? [] : [intType];
  const callable = vm.getMember(
    receiver,
    name,
    { kind: "function", params: parameters, result, suspend: false },
    "$builtin." + name,
  );
  return vm.invokeBuiltin(
    callable,
    parameters.length ? [argument] : [],
    parameters.map(() => null),
    false,
  );
}

test("primitive map lookups avoid scanning earlier keys and retain compatible numeric equality", () => {
  const vm = machine();
  const entries = Array.from({ length: 10000 }, (_, index) => [integer(index), integer(index + 1)]);
  const mapping = vm.collectionValue(type("MutableMap", [intType, intType]), entries);
  const equal = vm.equal.bind(vm);
  let comparisons = 0;
  vm.equal = (a, b, exact) => {
    comparisons++;
    return equal(a, b, exact);
  };
  for (let index = 0; index < entries.length; index++)
    assert.equal(vm.getIndex(mapping, integer(index)).value, index + 1);
  assert.equal(vm.getIndex(mapping, { kind: "float", value: 7 }).value, 8);
  assert.equal(vm.getIndex(mapping, integer(-1)).kind, "null");
  assert.ok(comparisons <= entries.length + 1);
});

test("set construction coalesces equal keys without rescanning every preceding element", () => {
  const vm = machine();
  const set = vm.collectionValue(type("Set", [intType]));
  const frame = { stack: [set] };
  const equal = vm.equal.bind(vm);
  let comparisons = 0;
  vm.equal = (a, b, exact) => {
    comparisons++;
    return equal(a, b, exact);
  };
  for (let index = 0; index < 5000; index++) {
    frame.stack.push(integer(index));
    executeInstruction(vm, { op: "collection_add" }, frame, () => frame.stack.pop());
  }
  frame.stack.push(integer(1));
  executeInstruction(vm, { op: "collection_add" }, frame, () => frame.stack.pop());
  assert.equal(vm.object(set).items.length, 5000);
  assert.equal(comparisons, 1);
});

test("removal, reinsertion, clearing, collection and restoration do not leave stale key positions", () => {
  const vm = machine();
  const mapping = vm.collectionValue(type("MutableMap", [intType, intType]), [
    [integer(1), integer(10)],
    [integer(2), integer(20)],
    [integer(3), integer(30)],
  ]);
  vm.declare(0, "mapping", mapping.type, false, mapping);
  assert.equal(vm.getIndex(mapping, integer(3)).value, 30);
  assert.equal(method(vm, mapping, "remove", integer(1)).value, 10);
  vm.writeAddress({ kind: "address", ref: mapping.ref, key: integer(1) }, integer(40));
  assert.deepEqual(
    vm.object(mapping).entries.map(([key]) => key.value),
    [2, 3, 1],
  );
  assert.equal(vm.getIndex(mapping, integer(3)).value, 30);
  assert.equal(vm.getIndex(mapping, integer(1)).value, 40);
  collectGarbage(vm);
  assert.equal(vm.getIndex(mapping, integer(2)).value, 20);
  assert.equal(vm.run().status, "waiting");
  const restored = VM.restore(vm.program, vm.save());
  const saved = restored.cell(0, "mapping").value;
  assert.equal(restored.getIndex(saved, integer(1)).value, 40);
  method(restored, saved, "clear");
  restored.writeAddress({ kind: "address", ref: saved.ref, key: integer(5) }, integer(50));
  assert.equal(restored.getIndex(saved, integer(1)).kind, "null");
  assert.equal(restored.getIndex(saved, integer(5)).value, 50);
});

test("composite keys retain structural equality and text buckets preserve Char/String and signed-zero equality", () => {
  const vm = machine();
  const listType = type("List", [intType]);
  const key = vm.collectionValue(listType, [integer(1), integer(2)]);
  const equalKey = vm.collectionValue(listType, [integer(1), integer(2)]);
  const mapping = vm.collectionValue(type("Map", [listType, intType]), [[key, integer(9)]]);
  assert.equal(vm.getIndex(mapping, equalKey).value, 9);
  const chars = vm.collectionValue(type("Set", [{ kind: "char" }]), [{ kind: "char", value: "a" }]);
  assert.equal(vm.contains(chars, { kind: "string", value: "a" }), true);
  const numbers = vm.collectionValue(type("Map", [{ kind: "float" }, intType]), [
    [{ kind: "float", value: -0 }, integer(4)],
  ]);
  assert.equal(vm.getIndex(numbers, integer(0)).value, 4);
});

test("unordered primitive equality selects matching buckets without quadratic key comparisons", () => {
  const vm = machine();
  const size = 2048;
  let reads = 0;
  // Count scalar inspections without imposing a machine-dependent time threshold.
  const keys = () =>
    Array.from({ length: size }, (_, number) =>
      Object.defineProperty({ kind: "int" }, "value", {
        get() {
          reads++;
          return number;
        },
        enumerable: true,
      }),
    );
  const first = keys(),
    second = keys().reverse();
  const leftSet = vm.collectionValue(type("Set", [intType]), first);
  const rightSet = vm.collectionValue(type("Set", [intType]), second);
  assert.equal(vm.equal(leftSet, rightSet), true);
  const leftMap = vm.collectionValue(
    type("Map", [intType, intType]),
    first.map((key, index) => [key, integer(index)]),
  );
  const rightMap = vm.collectionValue(
    type("Map", [intType, intType]),
    second.map((key, index) => [key, integer(size - index - 1)]),
  );
  assert.equal(vm.equal(leftMap, rightMap), true);
  assert.ok(reads < size * 12, "key inspection count must grow linearly for primitive keys");
});
