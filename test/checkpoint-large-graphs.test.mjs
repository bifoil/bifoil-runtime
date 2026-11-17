import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { collectGarbage } from "../src/collector.mjs";

test("large cyclic live graphs retain aliases across repeated checkpoints and post-restore collection", () => {
  const program = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  const nodeType = { kind: "named", name: "test.Node", args: [] };
  const integer = { kind: "int" };
  const listType = { kind: "named", name: "MutableList", args: [integer] };
  const fields = {
    next: { ty: { kind: "nullable", inner: nodeType }, mutable: true, private: false },
    value: { ty: integer, mutable: false, private: false },
    payload: { ty: listType, mutable: false, private: false },
  };
  program.types = {
    ...program.types,
    "test.Node": { kind: "data", parameters: [], field_order: Object.keys(fields), fields, methods: {}, variants: [] },
  };
  let machine = new VM(program);
  const initial = machine.run();
  assert.equal(initial.status, "waiting");
  const size = 20000;
  for (let index = 0; index < 1500; index++) machine.collectionValue(listType);
  const payload = machine.collectionValue(listType, [{ kind: "int", value: 0 }]);
  const nodes = [];
  for (let index = 0; index < size; index++) {
    const bindings = {};
    for (const [name, value] of Object.entries({
      next: { kind: "null", value: null },
      value: { kind: "int", value: index },
      payload,
    })) {
      bindings[name] =
        machine.state.cells.push({ ty: fields[name].ty, mutable: fields[name].mutable, initialized: true, value }) - 1;
    }
    nodes.push(machine.allocateObject({ kind: "data", type: nodeType, fields: bindings }));
  }
  for (let index = 0; index < size; index++)
    machine.state.cells[machine.object(nodes[index]).fields.next].value = nodes[(index + 1) % size];
  machine.declare(0, "largeRoot", nodeType, false, nodes[0]);
  machine.declare(0, "largeAlias", nodeType, false, nodes[0]);
  for (let round = 0; round < 4; round++) {
    const checkpoint = machine.save();
    assert.ok(checkpoint.length > 8 * 1024 * 1024);
    machine = VM.restore(program, checkpoint);
    const root = machine.cell(0, "largeRoot").value;
    assert.equal(root.ref, machine.cell(0, "largeAlias").value.ref);
    let current = root;
    let shared;
    for (let index = 0; index < size; index++) {
      const object = machine.object(current);
      assert.equal(machine.state.cells[object.fields.value].value.value, index);
      const value = machine.state.cells[object.fields.payload].value;
      shared ??= value;
      assert.equal(value.ref, shared.ref);
      current = machine.state.cells[object.fields.next].value;
    }
    assert.equal(current.ref, root.ref);
    assert.deepEqual(
      machine.object(shared).items.map((item) => item.value),
      Array.from({ length: round + 1 }, (_, index) => index),
    );
    machine.object(shared).items.push({ kind: "int", value: round + 1 });
    for (let index = 0; index < 1000; index++) {
      const env = machine.environment(0);
      machine.declare(env, "discarded", listType, false, machine.collectionValue(listType));
    }
    const reclaimed = collectGarbage(machine);
    assert.ok(reclaimed.objects >= 1000 && reclaimed.cells >= 1000 && reclaimed.envs >= 1000);
    assert.equal(machine.cell(0, "largeRoot").value.ref, machine.cell(0, "largeAlias").value.ref);
  }
  const result = machine.choose(0);
  assert.equal(result.status, "done");
  assert.deepEqual([...initial.output, ...result.output], ["Result 12; counter 2; next 3; after 3."]);
});
