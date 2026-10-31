import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { collectGarbage } from "../src/collector.mjs";

function largeProgram() {
  const program = JSON.parse(readFileSync(new URL("./fixtures/unicode.json", import.meta.url), "utf8"));
  const span = { file: "src/functions.bfl", line: 1 };
  for (let number = 0; number < 3000; number++) {
    const id = "bulk.fn" + number;
    program.functions[id] = {
      signature: { id, params: [], result: { kind: "unit" }, suspend: false, scene: false },
      local: false,
      init: false,
      code: [
        { op: "constant", ty: { kind: "unit" }, value: null, span },
        { op: "return", span },
      ],
    };
  }
  const entry = program.functions[program.entry];
  for (const instruction of entry.code) {
    if (Number.isInteger(instruction.target)) instruction.target += 3;
    if (Number.isInteger(instruction.fallback)) instruction.fallback += 3;
  }
  entry.code.unshift(
    { op: "load", name: "bulk.fn0", span },
    { op: "call", names: [], direct: false, span },
    { op: "pop", span },
  );
  return program;
}

test("global declarations do not allocate a heap cell per function and remain callable after restoration", () => {
  const program = largeProgram();
  let machine = new VM(program);
  assert.equal(machine.state.cells.length, 4);
  assert.equal(Object.hasOwn(machine.state.envs[0].bindings, "bulk.fn0"), false);
  const selected = machine.cell(0, "bulk.fn0");
  assert.equal(selected.mutable, false);
  machine.declare(0, "selected", selected.ty, false, selected.value);
  assert.throws(() => machine.declare(0, "bulk.fn0", selected.ty, false, selected.value), /duplicate runtime binding/);
  let result = machine.run();
  const output = [...result.output];
  while (result.status === "waiting") {
    collectGarbage(machine);
    machine = VM.restore(program, machine.save());
    assert.equal(machine.cell(0, "selected").value.id, "bulk.fn0");
    assert.equal(machine.cell(0, "bulk.fn2999").value.id, "bulk.fn2999");
    result = machine.choose(0);
    output.push(...result.output);
  }
  assert.equal(result.status, "done");
  assert.deepEqual(output, ["A😀é"]);
});

test("older v2 checkpoints with explicit global function cells remain loadable", () => {
  const program = largeProgram();
  const machine = new VM(program);
  const binding = machine.cell(0, "bulk.fn0");
  const id = machine.state.cells.push(binding) - 1;
  Object.defineProperty(machine.state.envs[0].bindings, "bulk.fn0", { value: id, enumerable: true });
  machine.run();
  const restored = VM.restore(program, machine.save());
  assert.equal(restored.cell(0, "bulk.fn0").value.id, "bulk.fn0");
  assert.equal(restored.cell(0, "bulk.fn1").value.id, "bulk.fn1");
});

test("an impossible control-flow path fails once at its original source location", () => {
  const program = largeProgram();
  program.functions[program.entry].code = [{ op: "unreachable", span: { file: "src/impossible.bfl", line: 42 } }];
  const machine = new VM(program);
  assert.throws(() => machine.run(), /src\/impossible.bfl:42: reached unreachable control flow/);
  assert.throws(() => machine.run(), /src\/impossible.bfl:42: reached unreachable control flow/);
  assert.throws(() => machine.save(), /reached unreachable control flow/);
});
