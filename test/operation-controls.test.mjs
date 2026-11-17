import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { executeInstruction } from "../src/operations.mjs";
import { int, value, nullValue } from "../src/values.mjs";

const integer = { kind: "int" };
const named = (name, ...args) => ({ kind: "named", name, args });
const text = (input) => value("string", input);
function context() {
  const machine = new VM(JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8")));
  const frame = { env: machine.environment(0), stack: [], pc: 0, typeArgs: {} };
  const run = (instruction, ...inputs) => {
    frame.stack.push(...inputs);
    return executeInstruction(machine, instruction, frame, () => {
      assert.ok(frame.stack.length, "Test instruction consumed a missing operand");
      return frame.stack.pop();
    });
  };
  return { machine, frame, run };
}

test("instruction guards reject invalid unwrapping, casts, updates and loop control", () => {
  const { machine, frame, run } = context();
  assert.throws(() => run({ op: "assert_present" }, nullValue()), /non-null assertion/);
  run({ op: "assert_present" }, int(7));
  assert.equal(frame.stack.pop().value, 7);
  run({ op: "cast", ty: integer, safe: true }, text("bad"));
  assert.equal(frame.stack.pop().kind, "null");
  assert.throws(() => run({ op: "cast", ty: integer, safe: false }, text("bad")), /checked cast/);
  run({ op: "type_test", ty: integer, negate: true }, text("bad"));
  assert.equal(frame.stack.pop().value, true);
  for (const whenNull of [true, false]) {
    frame.pc = 0;
    run({ op: "jump_null", when_null: whenNull, target: 9 }, nullValue());
    assert.equal(frame.pc, whenNull ? 9 : 0);
  }
  assert.throws(() => run({ op: "address_member", name: "x" }, int(1)), /requires data/);
  const immutable = machine.collectionValue(named("List", integer));
  assert.throws(() => run({ op: "address_index" }, immutable, int(0)), /indexed update/);
  assert.throws(() => run({ op: "iter_next", id: 8, target: 9, name: "i", ty: integer }), /missing loop/);
  run({ op: "iter_end", id: 0 });
  for (const id of [-1, 0.5]) assert.throws(() => run({ op: "stack_mark", id }), /invalid loop stack mark/);
  assert.throws(() => run({ op: "stack_reset", id: 0 }), /invalid loop stack reset/);
  assert.throws(() => run({ op: "stack_end", id: 0 }), /invalid loop stack end/);
  frame.stack.length = 0;
  frame.loopMarks = [{ id: 4, depth: 1 }];
  assert.throws(() => run({ op: "stack_reset", id: 4 }), /invalid loop stack reset/);
  assert.throws(() => run({ op: "stack_end", id: 5 }), /invalid loop stack end/);
  for (const count of [-1, 0.5, 2]) assert.throws(() => run({ op: "unwind", count }), /scope unwind/);
  assert.equal(run({ op: "not_an_instruction" }), false);
});

test("uninitialized declarations obey the same heap limit as initialized declarations", () => {
  const { machine, frame, run } = context();
  const instruction = { op: "uninitialized", name: "pending", ty: integer, mutable: true };
  run(instruction);
  const cell = machine.cell(frame.env, "pending");
  assert.equal(cell.initialized, false);
  assert.equal(cell.value, null);
  assert.throws(() => run(instruction), /duplicate binding/);
  machine.state.cells.length = 99999;
  run({ ...instruction, name: "lastAllowed" });
  assert.equal(machine.state.cells.length, 100000);
  assert.throws(() => run({ ...instruction, name: "overLimit" }), /runtime heap budget/);
  assert.equal(Object.hasOwn(machine.state.envs[frame.env].bindings, "overLimit"), false);
  assert.equal(machine.state.cells.length, 100000);
});

test("constructors validate field declarations and heap capacity before creating an instance", () => {
  const { machine, frame, run } = context();
  machine.program.types ??= {};
  machine.program.types.Counter = {
    kind: "data",
    parameters: [],
    fields: { count: { ty: integer, mutable: true } },
    methods: {},
  };
  const instruction = { op: "construct", ty: named("Counter"), fields: ["count"] };
  assert.throws(() => run({ ...instruction, ty: named("Missing") }, int(1)), /unknown data constructor/);
  frame.stack.length = 0;
  assert.throws(() => run(instruction), /unknown data constructor/);
  assert.throws(() => run({ ...instruction, fields: ["missing"] }, int(1)), /invalid data field/);
  assert.throws(() => run(instruction, text("bad")), /invalid data field/);
  run(instruction, int(3));
  const counter = frame.stack.pop();
  run({ op: "address_member", name: "count" }, counter);
  const address = frame.stack.pop();
  assert.equal(machine.readAddress(address).value, 3);
  assert.throws(() => run({ op: "address_member", name: "missing" }, counter), /field is immutable/);
  machine.state.cells[machine.object(counter).fields.count].mutable = false;
  assert.throws(() => run({ op: "address_member", name: "count" }, counter), /field is immutable/);
  machine.state.cells.length = 100000;
  assert.throws(() => run(instruction, int(4)), /runtime heap budget/);
});

test("range instructions reject invalid bounds and steps and traverse empty descending ranges", () => {
  const { frame, run } = context();
  const range = { op: "range", descending: false, exclusive: false };
  for (const inputs of [
    [text("x"), int(2)],
    [int(1), text("x")],
    [int(3), int(1)],
  ])
    assert.throws(() => run(range, ...inputs), /range bounds|ascending range/);
  assert.throws(() => run({ ...range, exclusive: true }, int(2), int(2)), /ascending range/);
  run({ ...range, descending: true }, int(1), int(3));
  const empty = frame.stack.pop();
  assert.equal(empty.empty, true);
  run({ op: "range_step" }, empty, int(2));
  const stepped = frame.stack.pop();
  assert.equal(stepped.empty, true);
  assert.equal(stepped.last, 3);
  for (const [receiver, step] of [
    [int(1), int(2)],
    [empty, text("2")],
    [empty, int(0)],
    [empty, int(-1)],
  ])
    assert.throws(() => run({ op: "range_step" }, receiver, step), /positive Int/);
  run({ op: "iter_start", id: 1 }, stepped);
  run({ op: "iter_next", id: 1, target: 99, name: "i", ty: integer });
  assert.equal(frame.pc, 99);
});

test("prose instructions retain nested paragraph boundaries and reject malformed contexts", () => {
  const { machine, frame, run } = context();
  assert.throws(() => run({ op: "prose_text" }, text("outside")), /invalid prose text/);
  run({ op: "prose_start" });
  assert.throws(() => run({ op: "prose_text" }, int(1)), /invalid prose text/);
  run({ op: "prose_text" }, text("First"));
  run({ op: "prose_text" }, text("paragraph."));
  run({ op: "prose_start" });
  run({ op: "prose_text" }, text("Nested."));
  frame.proseBase = 0;
  run({ op: "prose_unwind", depth: 0 });
  assert.deepEqual(machine.drainOutput(), ["First paragraph.", "Nested."]);
  for (const depth of [-1, 1, 0.5]) assert.throws(() => machine.closeProse(depth), /invalid prose unwind/);
  machine.state.prose.push(null);
  assert.throws(() => machine.flushProse(), /invalid prose context/);
});

test("function and scene instructions reject missing or non-scene targets", () => {
  const { machine, frame, run } = context();
  assert.throws(() => run({ op: "function_value", function: "missing", captures: [] }), /unknown anonymous/);
  assert.throws(() => run({ op: "scene_call", names: [], transfer: false }, int(1)), /not a Scene/);
  const scene = { kind: "scene", id: machine.program.entry, env: 0 };
  assert.throws(() => run({ op: "scene_call", names: [], transfer: true }, scene), /no active scene visit/);
  assert.equal(frame.stack.length, 0);
});
