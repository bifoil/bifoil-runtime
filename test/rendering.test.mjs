import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";

const type = (name, args = []) => ({ kind: "named", name, args });
const integer = (value) => ({ kind: "int", value });
function machine() {
  return new VM(JSON.parse(readFileSync(new URL("./fixtures/unicode.json", import.meta.url), "utf8")));
}

test("explicit rendering handles deep containers without using the host call stack", () => {
  const vm = machine();
  let item = integer(7);
  const list = type("List", [{ kind: "nullable", inner: { kind: "any" } }]);
  for (let depth = 0; depth < 12000; depth++) item = vm.collectionValue(list, [item]);
  const rendered = vm.stringify(item);
  assert.equal(rendered.length, 24001);
  assert.equal(rendered, "[".repeat(12000) + "7" + "]".repeat(12000));
});

test("rendering distinguishes active cycles from repeated aliases and preserves entry order", () => {
  const vm = machine();
  const listType = type("MutableList", [{ kind: "nullable", inner: { kind: "any" } }]);
  const leaf = vm.collectionValue(listType, [integer(1)]);
  const shared = vm.collectionValue(listType, [leaf, leaf]);
  assert.equal(vm.stringify(shared), "[[1], [1]]");
  vm.object(leaf).items.push(shared);
  assert.equal(vm.stringify(shared), "[[1, <cycle>], [1, <cycle>]]");
  const mapping = vm.collectionValue(type("Map", [{ kind: "string" }, { kind: "int" }]), [
    [{ kind: "string", value: "first" }, integer(1)],
    [{ kind: "string", value: "second" }, integer(2)],
  ]);
  assert.equal(vm.stringify(mapping), "{first: 1, second: 2}");
});
