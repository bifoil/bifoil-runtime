import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { collectGarbage } from "../src/collector.mjs";

function captureProgram() {
  const program = JSON.parse(readFileSync(new URL("./fixtures/unicode.json", import.meta.url), "utf8"));
  const int = { kind: "int" };
  const callback = { kind: "function", params: [], result: int, suspend: false };
  const list = { kind: "named", name: "List", args: [callback] };
  const integers = { kind: "named", name: "List", args: [int] };
  const code = (instructions) => instructions.map((op) => ({ ...op, span: { file: "src/captures.bfl", line: 1 } }));
  const fn = (id, result, instructions, local) => ({
    signature: { id, params: [], result, suspend: false, scene: false },
    code: code(instructions),
    local,
    init: false,
  });
  program.functions["capture.read"] = fn(
    "capture.read",
    int,
    [
      { op: "load", name: "used" },
      { op: "constant", ty: int, value: 1 },
      { op: "binary", operator: "+" },
      { op: "store", name: "used" },
      { op: "load", name: "used" },
      { op: "return" },
    ],
    true,
  );
  program.functions["capture.make"] = fn(
    "capture.make",
    list,
    [
      { op: "constant", ty: int, value: 10 },
      { op: "declare", name: "used", ty: int, mutable: true },
      { op: "begin_collection", ty: integers },
      { op: "constant", ty: int, value: 99 },
      { op: "collection_add" },
      { op: "declare", name: "unused", ty: integers, mutable: false },
      { op: "begin_collection", ty: list },
      { op: "function_value", function: "capture.read", captures: ["used"] },
      { op: "collection_add" },
      { op: "function_value", function: "capture.read", captures: ["used"] },
      { op: "collection_add" },
      { op: "return" },
    ],
    false,
  );
  program.functions[program.entry].code = code([
    { op: "load", name: "capture.make" },
    { op: "call", names: [], direct: true },
    { op: "declare", name: "saved", ty: list, mutable: false },
    { op: "begin_choice" },
    { op: "constant", ty: { kind: "boolean" }, value: true },
    { op: "constant", ty: { kind: "string" }, value: "Continue" },
    { op: "offer", target: 8 },
    { op: "choose", fallback: null },
    ...[0, 1].flatMap((index) => [
      { op: "load", name: "saved" },
      { op: "constant", ty: int, value: index },
      { op: "index" },
      { op: "call", names: [], direct: false },
      { op: "format", count: 1 },
      { op: "print" },
    ]),
    { op: "constant", ty: { kind: "unit" }, value: null },
    { op: "return" },
  ]);
  return program;
}

test("compact closures release unused enclosing state and share live cells through collection and restore", () => {
  const program = captureProgram();
  const machine = new VM(program);
  assert.equal(machine.run().status, "waiting");
  const reclaimed = collectGarbage(machine);
  assert.equal(reclaimed.objects, 1);
  assert.ok(reclaimed.cells >= 1);
  assert.ok(reclaimed.envs >= 1);
  const list = machine.cell(machine.state.frames[0].env, "saved").value;
  const [first, second] = machine.object(list).items;
  assert.deepEqual(Object.keys(machine.state.envs[first.env].bindings), ["used"]);
  assert.equal(machine.state.envs[first.env].parent, 0);
  assert.equal(machine.state.envs[first.env].bindings.used, machine.state.envs[second.env].bindings.used);
  machine.cell(first.env, "used").value = { kind: "int", value: 20 };
  const restored = VM.restore(program, machine.save());
  assert.deepEqual(restored.choose(0).output, ["21", "22"]);
});

test("capture metadata rejects duplicate names and reports missing cells at the original instruction", () => {
  const duplicate = captureProgram();
  duplicate.functions["capture.make"].code.find((op) => op.op === "function_value").captures = ["used", "used"];
  assert.throws(() => new VM(duplicate), /invalid closure capture names/);
  const missing = captureProgram();
  missing.functions["capture.make"].code.find((op) => op.op === "function_value").captures = ["missing"];
  const machine = new VM(missing);
  assert.throws(() => machine.run(), /src\/captures.bfl:1: unknown captured binding missing/);
});

test("unused local generic templates can be declared and collected without resolving their own parameters", () => {
  const program = captureProgram();
  const parameter = { kind: "parameter", name: "U" };
  const span = { file: "src/captures.bfl", line: 2 };
  program.functions["capture.identity"] = {
    signature: {
      id: "capture.identity",
      generics: [{ name: "U", bounds: [] }],
      params: [{ name: "item", ty: parameter, mutable: false, default: false }],
      result: parameter,
      suspend: false,
      scene: false,
    },
    code: [
      { op: "load", name: "item", span },
      { op: "return", span },
    ],
    local: true,
    init: false,
  };
  program.functions["capture.make"].code.splice(2, 0, {
    op: "closure",
    name: "identity",
    function: "capture.identity",
    span,
  });
  const machine = new VM(program);
  assert.equal(machine.run().status, "waiting");
  const template = machine.state.cells.find((cell) => cell.value?.id === "capture.identity");
  assert.deepEqual(template.ty.params, [parameter]);
  collectGarbage(machine);
  assert.equal(
    machine.state.cells.some((cell) => cell.value?.id === "capture.identity"),
    false,
  );
  const restored = VM.restore(program, machine.save());
  assert.deepEqual(restored.choose(0).output, ["11", "12"]);
});

function namedCaptureProgram() {
  const program = captureProgram();
  const span = { file: "src/captures.bfl", line: 1 };
  program.functions["capture.forward"] = {
    ...program.functions["capture.read"],
    signature: { ...program.functions["capture.read"].signature, id: "capture.forward" },
    code: [
      { op: "load", name: "read", span },
      { op: "call", names: [], direct: true, span },
      { op: "return", span },
    ],
  };
  const factory = program.functions["capture.make"];
  let reference = 0;
  factory.code = [
    { op: "closure", name: "forward", function: "capture.forward", captures: ["read"], span },
    { op: "closure", name: "read", function: "capture.read", captures: ["used", "forward"], span },
    ...factory.code.map((instruction) =>
      instruction.op === "function_value"
        ? { op: "load", name: reference++ === 0 ? "forward" : "read", span }
        : instruction,
    ),
  ];
  return program;
}

test("named capture cycles release unused factory state at a checkpoint and preserve shared cells", () => {
  const program = namedCaptureProgram();
  const machine = new VM(program);
  assert.equal(machine.run().status, "waiting");
  const objectsBefore = machine.state.objects.length;
  machine.save();
  assert.equal(machine.state.objects.length, objectsBefore - 1);
  const saved = machine.cell(machine.state.frames[0].env, "saved").value;
  const [first, second] = machine.object(saved).items;
  const delegated = machine.cell(first.env, "read").value;
  assert.equal(machine.cellId(delegated.env, "used"), machine.cellId(second.env, "used"));
  assert.deepEqual(Object.keys(machine.state.envs[first.env].bindings), ["read"]);
  assert.deepEqual(Object.keys(machine.state.envs[second.env].bindings), ["used", "forward"]);
  assert.equal(
    machine.state.envs.some((env) => Object.hasOwn(env.bindings, "unused")),
    false,
  );
  machine.cell(second.env, "used").value = { kind: "int", value: 20 };
  const restored = VM.restore(program, machine.save());
  assert.deepEqual(restored.choose(0).output, ["21", "22"]);
});

test("collection before a forward capture declaration keeps its future binding scope alive", () => {
  const program = namedCaptureProgram();
  const machine = new VM(program, null, { quantum: 1 });
  let reached = false;
  for (let step = 0; step < 20; step++) {
    machine.run();
    const frame = machine.state.frames.at(-1);
    if (frame?.function === "capture.make" && frame.pc === 2) {
      reached = true;
      assert.equal(machine.cellId(frame.env, "used"), null);
      collectGarbage(machine);
      break;
    }
  }
  assert.ok(reached, "factory declaration boundary was reached");
  let result;
  do result = machine.run();
  while (result.status === "running");
  assert.equal(result.status, "waiting");
  const restored = VM.restore(program, machine.save());
  assert.deepEqual(restored.choose(0).output, ["11", "12"]);
});

test("named closure sites require distinct and consistent capture metadata", () => {
  const duplicate = namedCaptureProgram();
  duplicate.functions["capture.make"].code[0].captures = ["read", "read"];
  assert.throws(() => new VM(duplicate), /invalid closure capture names/);
  const inconsistent = namedCaptureProgram();
  inconsistent.functions["capture.make"].code.push({
    ...inconsistent.functions["capture.make"].code[0],
    captures: [],
  });
  assert.throws(() => new VM(inconsistent), /inconsistent named closure captures/);
});
