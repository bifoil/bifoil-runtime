import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { collectGarbage } from "../src/collector.mjs";

test("collection reclaims unreachable cycles and retains aliases and escaping captures across save/load", () => {
  const program = JSON.parse(readFileSync(new URL("./fixtures/escaping.json", import.meta.url), "utf8"));
  const type = { kind: "named", name: "Loop", args: [] };
  program.types = {
    ...program.types,
    Loop: {
      kind: "data",
      parameters: [],
      field_order: ["self"],
      fields: { self: { ty: type, mutable: false, private: false } },
      methods: {},
      variants: [],
    },
  };
  const machine = new VM(program);
  machine.run();
  // This first object must disappear, so live object IDs actually move.
  const discarded = machine.allocateObject({ kind: "data", type, fields: {} });
  const deadEnvironment = machine.environment(0);
  machine.declare(deadEnvironment, "dead", type, false, discarded);
  machine.object(discarded).fields.self = machine.state.envs[deadEnvironment].bindings.dead;

  const cycle = machine.allocateObject({ kind: "data", type, fields: {} });
  machine.declare(0, "cycle", type, false, cycle);
  machine.declare(0, "alias", type, false, cycle);
  machine.object(cycle).fields.self = machine.state.envs[0].bindings.cycle;
  for (let i = 0; i < 12000; i++) {
    const environment = machine.environment(0);
    machine.declare(environment, "temporary", { kind: "int" }, false, { kind: "int", value: i });
    machine.collectionValue({ kind: "named", name: "List", args: [{ kind: "int" }] });
  }

  const reclaimed = collectGarbage(machine);
  assert.ok(reclaimed.cells >= 12001);
  assert.ok(reclaimed.envs >= 12001);
  assert.ok(reclaimed.objects >= 12001);
  const retained = machine.cell(0, "cycle").value;
  assert.strictEqual(retained, machine.cell(0, "alias").value);
  assert.equal(retained.ref, 0);
  assert.strictEqual(machine.state.cells[machine.object(retained).fields.self].value, retained);
  const restored = VM.restore(program, machine.save());
  const restoredCycle = restored.cell(0, "cycle").value;
  assert.equal(restoredCycle.ref, restored.cell(0, "alias").value.ref);
  assert.deepEqual(restored.choose(0).output, ["2 then 3."]);
});
