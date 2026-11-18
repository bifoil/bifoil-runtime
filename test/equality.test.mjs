import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { structuralEqual } from "../src/equality.mjs";

const type = (name, args = []) => ({ kind: "named", name, args });
const integer = (value) => ({ kind: "int", value });
function machine() {
  return new VM(JSON.parse(readFileSync(new URL("./fixtures/unicode.json", import.meta.url), "utf8")));
}
function record(vm, name, fields) {
  const bindings = {};
  for (const [key, value] of Object.entries(fields))
    bindings[key] = vm.state.cells.push({ ty: vm.valueType(value), mutable: false, initialized: true, value }) - 1;
  return vm.allocateObject({ kind: "data", type: type(name), fields: bindings });
}

test("deep nested unordered values compare without copying a pair set at each level", () => {
  const vm = machine(),
    branch = type("test.Branch"),
    children = type("Set", [branch]);
  function tree() {
    let node = record(vm, "test.Branch", { children: vm.collectionValue(children, []) });
    for (let depth = 0; depth < 6000; depth++)
      node = record(vm, "test.Branch", { children: vm.collectionValue(children, [node]) });
    return node;
  }
  const first = tree(),
    second = tree();
  assert.equal(vm.equal(first, second), true);
  assert.equal(vm.equal(first, second, true), true);
});

test("unordered candidate failures cannot contaminate another structural match", () => {
  const vm = machine(),
    ints = type("List", [{ kind: "int" }]),
    nested = type("List", [ints]);
  const list = (numbers) => vm.collectionValue(ints, numbers.map(integer));
  const one = list([1]),
    two = list([2]);
  const key = (first, last) => vm.collectionValue(nested, [first, list([last])]);
  const left = vm.collectionValue(type("Set", [nested]), [key(one, 3), key(one, 4)]);
  const wrong = vm.collectionValue(type("Set", [nested]), [key(two, 4), key(two, 3)]);
  const reordered = vm.collectionValue(type("Set", [nested]), [key(list([1]), 4), key(list([1]), 3)]);
  assert.equal(vm.equal(left, wrong), false);
  assert.equal(vm.equal(left, reordered), true);
  assert.equal(vm.equal(left, reordered, true), true);
  const map = type("Map", [nested, { kind: "int" }]);
  const a = vm.collectionValue(map, [
    [key(one, 3), integer(3)],
    [key(one, 4), integer(4)],
  ]);
  const b = vm.collectionValue(map, [
    [key(list([1]), 4), integer(4)],
    [key(list([1]), 3), integer(3)],
  ]);
  const c = vm.collectionValue(map, [
    [key(list([1]), 4), integer(3)],
    [key(list([1]), 3), integer(4)],
  ]);
  assert.equal(vm.equal(a, b), true);
  assert.equal(vm.equal(a, c), false);
});

test("structural comparison rejects unequal collection sizes and absent unordered keys", () => {
  const vm = machine();
  const ints = type("List", [{ kind: "int" }]);
  const first = vm.collectionValue(ints, [integer(1)]);
  const second = vm.collectionValue(ints, [integer(1), integer(2)]);
  assert.equal(vm.equal(first, second), false);
  const set = vm.collectionValue(type("Set", [{ kind: "int" }]), [integer(1)]);
  assert.equal(vm.equal(first, set), false);
  const map = type("Map", [{ kind: "int" }, { kind: "int" }]);
  const mapping = vm.collectionValue(map, [[integer(1), integer(2)]]);
  const larger = vm.collectionValue(map, [
    [integer(1), integer(2)],
    [integer(3), integer(4)],
  ]);
  const different = vm.collectionValue(map, [[integer(3), integer(2)]]);
  assert.equal(vm.equal(mapping, larger), false);
  assert.equal(vm.equal(mapping, different), false);
});

test("raw record comparisons reject inconsistent field inventories before reading absent cells", () => {
  const vm = machine();
  const first = record(vm, "test.Record", { value: integer(1) });
  const empty = record(vm, "test.Record", {});
  const renamed = record(vm, "test.Record", { different: integer(1) });
  assert.equal(vm.equal(first, empty), false);
  assert.equal(vm.equal(first, renamed), false);
});

test("scene identity and the public ordinary-comparison default retain their distinct contracts", () => {
  const program = JSON.parse(readFileSync(new URL("./fixtures/unicode.json", import.meta.url), "utf8"));
  const entry = program.functions[program.entry];
  program.functions["main.second"] = { ...entry, signature: { ...entry.signature, id: "main.second" } };
  const vm = new VM(program);
  const first = vm.cell(0, program.entry).value;
  const second = vm.cell(0, "main.second").value;
  assert.equal(first.kind, "scene");
  assert.equal(vm.equal(first, first), true);
  assert.equal(vm.equal(first, second), false);
  assert.equal(structuralEqual(vm, integer(1), { kind: "float", value: 1 }), true);
  assert.equal(structuralEqual(vm, integer(1), { kind: "float", value: 1 }, true), false);
});
