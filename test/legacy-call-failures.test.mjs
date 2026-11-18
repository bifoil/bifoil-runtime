import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { BifoilError } from "../src/errors.mjs";

const original = JSON.parse(readFileSync(new URL("./fixtures/legacy.json", import.meta.url), "utf8"));
const span = { file: "src/bridge.bfl", line: 4 };
function bridge(transfer = false) {
  const program = structuredClone(original);
  delete program.legacy_globals;
  const routine = program.functions["main.ask"];
  delete program.functions["main.bump"];
  routine.signature.result = { kind: transfer ? "nothing" : "int" };
  routine.code = [
    {
      op: "legacy_call",
      arguments: 0,
      target: {
        scene: "questions",
        label: "ask",
        result: transfer ? null : "answer",
        ...(transfer ? { transfer } : {}),
      },
      span,
    },
    { op: "return", span },
  ];
  program.functions[program.entry].code = [
    { op: "load", name: "main.ask", span },
    { op: "call", names: [], direct: true, span },
    { op: "pop", span },
    { op: "constant", ty: { kind: "unit" }, value: null, span },
    { op: "return", span },
  ];
  return program;
}

test("legacy failures retain checked source locations, valid completed output and terminal identity", () => {
  for (const [failure, expectedOutput] of [
    [Object.assign(new Error("host failed"), { legacyOutput: ["Completed."] }), ["Completed."]],
    [Object.assign(new Error("host failed"), { legacyOutput: ["Untrusted.", 7] }), []],
    [new BifoilError("host failed"), []],
    [new BifoilError("host failed", { file: "src/native.txt", line: 9 }), []],
  ]) {
    let starts = 0,
      cancellations = 0;
    const machine = new VM(bridge(), null, {
      legacy: {
        start() {
          starts++;
          throw failure;
        },
        cancel() {
          cancellations++;
        },
      },
    });
    let diagnostic;
    assert.throws(
      () => machine.run(),
      (error) => {
        diagnostic = error;
        assert.deepEqual(error.span, failure.span ?? span);
        if (failure.span) assert.equal(error, failure);
        return /host failed/.test(error.message);
      },
    );
    assert.deepEqual(machine.state.transcript, expectedOutput);
    assert.throws(
      () => machine.run(),
      (error) => error === diagnostic,
    );
    assert.throws(
      () => machine.save(),
      (error) => error === diagnostic,
    );
    assert.equal(starts, 1);
    assert.equal(cancellations, 1);
  }
});

test("legacy transfers own the continuation and reject ordinary-return protocol confusion", () => {
  for (const [transfer, status, message] of [
    [false, "transferred", /ordinary legacy bridge cannot transfer/],
    [true, "returned", /legacy transfer bridge cannot return/],
  ]) {
    const machine = new VM(bridge(transfer), null, { legacy: { start: () => ({ status, value: 1 }) } });
    assert.throws(() => machine.run(), message);
    assert.equal(machine.state.failed, true);
  }
  let originalStarts = 0,
    restoredStarts = 0,
    resumes = 0;
  const originalMachine = new VM(bridge(true), null, {
    legacy: {
      start(request) {
        originalStarts++;
        assert.equal(request.suspend, true);
        return { status: "waiting", options: [{ label: "Continue", enabled: true }], continuation: { token: 3 } };
      },
      snapshot: () => ({ saved: true }),
    },
  });
  assert.equal(originalMachine.run().status, "waiting");
  assert.equal(originalMachine.state.frames.length, 1);
  const restored = VM.restore(bridge(true), originalMachine.save(), {
    legacy: {
      start() {
        restoredStarts++;
      },
      restore(saved) {
        assert.deepEqual(saved, { saved: true });
      },
      resume(request, continuation, index) {
        resumes++;
        assert.equal(request.target.transfer, true);
        assert.deepEqual(continuation, { token: 3 });
        assert.equal(index, 0);
        return { status: "transferred", output: ["After transfer."] };
      },
    },
  });
  assert.equal(restored.choose(0).status, "done");
  assert.deepEqual(restored.state.transcript, ["After transfer."]);
  assert.deepEqual(restored.state.frames, []);
  assert.deepEqual(restored.state.boot, []);
  assert.equal(restored.state.pending, null);
  assert.deepEqual([originalStarts, restoredStarts, resumes], [1, 0, 1]);
});

test("legacy transfer interfaces reject non-suspending, returning and result-bound declarations", () => {
  for (const change of [
    (routine) => {
      routine.signature.suspend = false;
    },
    (routine) => {
      routine.signature.result = { kind: "int" };
    },
    (routine) => {
      routine.code[0].target.result = "answer";
    },
  ]) {
    const program = bridge(true);
    change(program.functions["main.ask"]);
    assert.throws(() => new VM(program), /invalid legacy call interface/);
  }
});

test("providing an unused host does not invent native state in repeated ordinary checkpoints", () => {
  const program = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  let snapshots = 0;
  const machine = new VM(program, null, {
    legacy: {
      snapshot() {
        snapshots++;
        return {};
      },
    },
  });
  assert.equal(machine.run().status, "waiting");
  const first = machine.save();
  assert.equal(machine.save(), first);
  assert.equal(snapshots, 0);
});
