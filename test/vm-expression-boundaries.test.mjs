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
