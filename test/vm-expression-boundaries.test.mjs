import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";

function program(ops) {
  const data = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  const entry = data.functions[data.entry];
  data.functions = { [data.entry]: entry };
  const span = { file: "src/original.bfl", line: 1 };
  entry.code = [...ops, { op: "constant", ty: { kind: "unit" }, value: null }, { op: "return" }].map((op) => ({
    ...op,
    span,
  }));
  return data;
}

const constant = (kind, value) => ({ op: "constant", ty: { kind }, value });
const output = [{ op: "format", count: 1 }, { op: "print" }];

test("VM unary instructions check operands and retain Int versus Float negation", () => {
  for (const [kind, value, operator, expected] of [
    ["boolean", true, "!", "false"],
    ["boolean", false, "!", "true"],
    ["int", 4, "-", "-4"],
    ["float", 2.5, "-", "-2.5"],
  ]) {
    const machine = new VM(program([constant(kind, value), { op: "unary", operator }, ...output]));
    assert.deepEqual(machine.run().output, [expected]);
  }
  for (const [kind, value, operator, message] of [
    ["int", 1, "!", /Boolean operand required/],
    ["boolean", true, "-", /invalid unary operand/],
    ["int", 1, "unknown", /invalid unary operand/],
    ["int", -2147483648, "-", /overflow/],
  ])
    assert.throws(() => new VM(program([constant(kind, value), { op: "unary", operator }])).run(), message);
});

test("VM exact-comparison instructions apply negation after comparing declared views", () => {
  for (const negate of [false, true]) {
    const data = program([
      constant("int", 3),
      constant("int", 3),
      { op: "exact_compare", left_type: { kind: "int" }, right_type: { kind: "int" }, negate },
      ...output,
    ]);
    data.profile = "bifoil-vm.v3";
    data.format = "bifoil.program.v2";
    const machine = new VM(data);
    assert.deepEqual(machine.run().output, [String(!negate)]);
  }
});

test("empty VM choices take explicit fallback while a terminal empty choice reports failure", () => {
  const fallback = new VM(program([{ op: "begin_choice" }, { op: "choose", fallback: 2 }]));
  assert.equal(fallback.run().status, "done");
  assert.equal(fallback.state.pending, null);
  assert.throws(
    () => new VM(program([{ op: "begin_choice" }, { op: "choose", fallback: null }])).run(),
    /choice has no selectable options/,
  );
  const once = new VM(
    program([
      { op: "begin_choice" },
      constant("boolean", true),
      constant("string", "Original option"),
      { op: "offer", target: 5, once: "original-once" },
      { op: "choose", fallback: null },
    ]),
  );
  assert.equal(once.run().status, "waiting");
  assert.equal(once.state.pending.options[0].once, "original-once");
  assert.equal(once.choose(0).status, "done");
});

test("an uninitialized immutable binding accepts one assignment and rejects a later write", () => {
  const machine = new VM(
    program([
      { op: "uninitialized", name: "once", ty: { kind: "int" }, mutable: false },
      constant("int", 7),
      { op: "store", name: "once" },
      { op: "load", name: "once" },
      ...output,
      constant("int", 8),
      { op: "store", name: "once" },
    ]),
  );
  assert.throws(() => machine.run(), /invalid binding assignment/);
  assert.deepEqual(machine.state.transcript, ["7"]);
});

test("explicit boot calls evaluate omitted defaults once while ordinary calls require arguments", () => {
  const input = program([
    { op: "default", name: "seed", target: 3 },
    constant("int", 7),
    { op: "declare", name: "seed", ty: { kind: "int" }, mutable: false },
    { op: "load", name: "seed" },
    ...output,
  ]);
  input.functions[input.entry].signature.params = [
    { name: "seed", ty: { kind: "int" }, mutable: false, default: true },
  ];
  for (const args of [[], [{ kind: "int", value: 9 }]]) {
    const machine = new VM(input);
    const kind = machine.functionType(input.functions[input.entry].signature).kind === "scene" ? "scene" : "function";
    machine.pushCall(
      { kind, id: input.entry, env: 0 },
      args,
      args.map(() => null),
      { direct: false, boot: true },
    );
    machine.state.boot = [];
    assert.deepEqual(machine.run().output, [args.length ? "9" : "7"]);
  }
  const ordinary = new VM(input);
  const callable = ordinary.cell(0, input.entry).value;
  assert.throws(() => ordinary.pushCall(callable, [], [], { direct: false }), /missing argument seed/);
});

test("an explicit unreachable instruction fails at its original source position", () => {
  const machine = new VM(program([{ op: "unreachable" }]));
  assert.throws(() => machine.run(), /src\/original.bfl:1: reached unreachable control flow/);
});

test("an explicitly empty shared initialization order needs no shared declarations", () => {
  const input = program([]);
  delete input.shared;
  input.shared_order = [];
  assert.equal(new VM(input).run().status, "done");
});

test("duplication preserves its operand and widening creates a checked Float", () => {
  const machine = new VM(
    program([
      constant("int", 7),
      { op: "dup" },
      { op: "declare", name: "copy", ty: { kind: "int" }, mutable: false },
      { op: "widen" },
      { op: "declare", name: "wide", ty: { kind: "float" }, mutable: false },
    ]),
  );
  assert.equal(machine.run().status, "done");
  assert.ok(machine.state.cells.some((cell) => cell.value?.kind === "int" && cell.value.value === 7));
  assert.ok(machine.state.cells.some((cell) => cell.value?.kind === "float" && cell.value.value === 7));
  assert.throws(() => new VM(program([constant("boolean", true), { op: "widen" }])).run(), /invalid widening/);
});

test("host mutation after validation cannot execute an unknown instruction or resume after failure", () => {
  const input = program([constant("int", 1)]);
  const machine = new VM(input);
  input.functions[input.entry].code[0].op = "unknown_after_validation";
  let diagnostic;
  assert.throws(
    () => machine.run(),
    (error) => {
      diagnostic = error;
      return /src\/original.bfl:1: unknown instruction/.test(error.message);
    },
  );
  assert.equal(machine.state.failed, true);
  assert.throws(
    () => machine.run(),
    (error) => error === diagnostic,
  );
});
