import test from "node:test";
import assert from "node:assert/strict";
import { VM } from "../src/vm.mjs";

const int = { kind: "int" };
const unit = { kind: "unit" };
const instruction = (op) => ({ ...op, span: { file: "src/shared.bfl", line: 4 } });
const body = (id, result, code, scene = false) => ({
  signature: { id, params: [], result, suspend: scene, scene },
  code: code.map(instruction),
  init: false,
  local: !scene,
});
function program() {
  return {
    format: "bifoil.program.v2",
    profile: "bifoil-vm.v2",
    build: "a".repeat(64),
    entry: "story.start",
    modules: {},
    init: [],
    shared: {
      "story.a": { ty: int, mutable: false, initializer: "story.initA", order: 0, dependencies: ["story.b"] },
      "story.b": { ty: int, mutable: false, initializer: "story.initB", order: 1, dependencies: [] },
    },
    shared_order: ["story.b", "story.a"],
    functions: {
      "story.initA": body("story.initA", int, [{ op: "load", name: "story.b" }, { op: "return" }]),
      "story.initB": body("story.initB", int, [{ op: "constant", ty: int, value: 7 }, { op: "return" }]),
      "story.start": body("story.start", unit, [{ op: "constant", ty: unit, value: null }, { op: "return" }], true),
    },
  };
}

test("shared startup rejects missing, duplicate and unordered plan entries", () => {
  for (const order of [["story.a", "story.b"], ["story.b"], ["story.b", "story.b", "story.a"]]) {
    const input = program();
    input.shared_order = order;
    assert.throws(() => new VM(input), /shared/);
  }
  const input = program();
  delete input.shared_order;
  assert.throws(() => new VM(input), /shared initialization order/);
});

test("shared startup executes once and unreported dependency reads fail at their source span", () => {
  const valid = new VM(program());
  valid.run();
  assert.equal(valid.cell(0, "story.a").value.value, 7);
  assert.equal(valid.cell(0, "story.b").value.value, 7);
  valid.run();
  assert.equal(valid.cell(0, "story.a").value.value, 7);

  const invalid = program();
  invalid.shared["story.a"].dependencies = [];
  invalid.shared_order = ["story.a", "story.b"];
  assert.throws(() => new VM(invalid).run(), /src\/shared.bfl:4:.*not initialized/);
});
