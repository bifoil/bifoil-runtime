import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { collectGarbage } from "../src/collector.mjs";

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

test("the call-depth boundary preserves every pending operand across a deepest-frame checkpoint", () => {
  const program = fixture("capacity-depth");
  let machine = new VM(program);
  assert.equal(machine.run().status, "waiting");
  const deepest = machine.choose(0);
  assert.equal(deepest.status, "waiting");
  assert.deepEqual(
    deepest.options.map((option) => option.label),
    ["Unwind"],
  );
  assert.equal(machine.state.frames.length, 1024);
  for (const frame of machine.state.frames.slice(1, -1)) {
    assert.deepEqual(frame.stack, [{ kind: "int", value: 1 }]);
  }
  machine = VM.restore(program, machine.save());
  assert.equal(machine.state.frames.length, 1024);
  for (const frame of machine.state.frames.slice(1, -1)) {
    assert.deepEqual(frame.stack, [{ kind: "int", value: 1 }]);
  }
  const result = machine.choose(0);
  assert.equal(result.status, "done");
  assert.deepEqual(result.output, ["Depth 1022."]);
  assert.equal(machine.state.frames.length, 0);
});

test("the next recursive call reports the depth guard and permanently stops the story", () => {
  const machine = new VM(fixture("capacity-depth"));
  assert.equal(machine.run().status, "waiting");
  let original;
  assert.throws(
    () => machine.choose(1),
    (error) => {
      original = error;
      return /runtime call-depth budget exceeded/.test(error.message);
    },
  );
  assert.equal(machine.state.frames.length, 1024);
  assert.equal(machine.state.failed, true);
  assert.equal(machine.state.pending, null);
  for (const operation of [() => machine.run(), () => machine.save(), () => machine.choose(0)]) {
    assert.throws(operation, (error) => error === original);
  }
});

test("long execution crosses instruction slices and collects temporary cells, scopes, and objects", () => {
  const machine = new VM(fixture("capacity-execution"), null, { quantum: 2048 });
  const output = [];
  let slices = 0;
  let peak = 0;
  let result;
  do {
    result = machine.run();
    output.push(...result.output);
    peak = Math.max(peak, machine.state.cells.length, machine.state.envs.length, machine.state.objects.length);
    slices++;
    assert.ok(slices < 10000, "bounded workload did not terminate");
  } while (result.status === "running");
  assert.equal(result.status, "done");
  assert.ok(slices > 100, "workload did not exercise repeated instruction yields");
  assert.ok(machine.lastCollectionSize !== undefined, "automatic collection did not run");
  assert.ok(peak < 20000, `temporary state accumulated to ${peak} records`);
  assert.deepEqual(output, ["Checksum 28."]);
});

test("a fully live object heap reaches its guard without losing rooted aliases or contents", () => {
  const machine = new VM(fixture("capacity-depth"));
  assert.equal(machine.run().status, "waiting");
  const inner = { kind: "named", name: "List", args: [{ kind: "int" }] };
  const outer = { kind: "named", name: "MutableList", args: [inner] };
  const root = machine.collectionValue(outer);
  machine.declare(0, "capacityRoot", outer, false, root);
  machine.declare(0, "capacityAlias", outer, false, root);
  const retained = machine.object(root).items;
  while (machine.state.objects.length < 100000) retained.push(machine.collectionValue(inner));
  assert.equal(retained.length, 99999);
  assert.throws(() => machine.collectionValue(inner), /runtime object budget exceeded/);
  assert.equal(machine.state.objects.length, 100000);
  const reclaimed = collectGarbage(machine);
  assert.equal(reclaimed.objects, 0);
  const savedRoot = machine.cell(0, "capacityRoot").value;
  assert.equal(savedRoot.ref, machine.cell(0, "capacityAlias").value.ref);
  const contents = machine.object(savedRoot).items;
  assert.equal(contents.length, 99999);
  for (const item of contents) assert.equal(machine.object(item).items.length, 0);
});
