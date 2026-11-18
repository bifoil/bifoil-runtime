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
  delete frame.proseBase;
  run({ op: "prose_start" });
  run({ op: "prose_text" }, text("Default scope."));
  run({ op: "prose_unwind", depth: 0 });
  assert.deepEqual(machine.drainOutput(), ["Default scope."]);
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

test("instruction values preserve specialization, conversions, captures and successful casts", () => {
  const { machine, frame, run } = context();
  const callable = { kind: "function", id: "helpers.add", env: 0 };
  for (const original of [callable, { ...callable, typeArgs: { Existing: integer } }]) {
    run({ op: "specialize", args: { Element: integer } }, original);
    const specialized = frame.stack.pop();
    assert.equal(specialized.id, "helpers.add");
    assert.deepEqual(specialized.typeArgs.Element, integer);
    assert.equal(Object.hasOwn(original, "typeArgs"), original !== callable);
  }
  machine.declare(frame.env, "captured", integer, true, int(7));
  frame.typeArgs = { Element: integer };
  run({ op: "function_value", function: "helpers.add", captures: ["captured"] });
  const closure = frame.stack.pop();
  assert.equal(machine.cell(closure.env, "captured"), machine.cell(frame.env, "captured"));
  assert.deepEqual(closure.typeArgs, frame.typeArgs);
  assert.notEqual(closure.typeArgs, frame.typeArgs);
  run({ op: "convert", ty: { kind: "float" } }, int(4));
  assert.deepEqual(frame.stack.pop(), value("float", 4));
  run({ op: "cast", ty: integer, safe: false }, int(4));
  assert.deepEqual(frame.stack.pop(), int(4));
  run({ op: "type_test", ty: integer, negate: false }, int(4));
  assert.deepEqual(frame.stack.pop(), value("boolean", true));
  run({ op: "jump_null", when_null: false, target: 17 }, int(4));
  assert.equal(frame.pc, 17);
  assert.equal(run({ op: "toString" }), false);
});

test("collection-building instructions retain order, reject duplicates and support captured addresses", () => {
  const { machine, frame, run } = context();
  run({ op: "begin_collection", ty: named("MutableList", integer) });
  const list = frame.stack.at(-1);
  run({ op: "collection_add" }, int(4));
  run({ op: "collection_add" }, int(9));
  frame.stack.pop();
  run({ op: "index" }, list, int(1));
  assert.deepEqual(frame.stack.pop(), int(9));
  run({ op: "member", name: "size", ty: integer }, list);
  assert.deepEqual(frame.stack.pop(), int(2));
  run({ op: "address_index" }, list, int(0));
  run({ op: "read_address" });
  assert.deepEqual(frame.stack.pop(), int(4));
  run({ op: "write_address" }, int(12));
  assert.deepEqual(machine.getIndex(list, int(0)), int(12));

  run({ op: "begin_collection", ty: named("Set", integer) });
  const set = frame.stack.at(-1);
  for (const number of [2, 2, 3]) run({ op: "collection_add" }, int(number));
  assert.deepEqual(
    machine.object(set).items.map((item) => item.value),
    [2, 3],
  );
  frame.stack.pop();

  run({ op: "begin_collection", ty: named("Map", { kind: "string" }, integer) });
  const map = frame.stack.at(-1);
  run({ op: "check_key" }, text("first"));
  run({ op: "collection_put" }, int(8));
  assert.throws(() => run({ op: "check_key" }, text("first")), /duplicate map key/);
  frame.stack.length = 0;
  assert.deepEqual(machine.getIndex(map, text("first")), int(8));
});

test("iteration instructions snapshot list and map values and count Unicode scalar characters", () => {
  const { machine, frame, run } = context();
  const map = machine.collectionValue(named("MutableMap", { kind: "string" }, integer));
  machine.object(map).entries.push([text("first"), int(5)]);
  const list = machine.collectionValue(named("MutableList", integer));
  machine.object(list).items.push(int(6));
  for (const [iterable, type] of [
    [list, integer],
    [map, named("Entry", { kind: "string" }, integer)],
  ]) {
    run({ op: "iter_start", id: 1 }, iterable);
    if (iterable === list) machine.object(list).items.push(int(99));
    else machine.object(map).entries.push([text("later"), int(99)]);
    const instruction = { op: "iter_next", id: 1, target: 40, name: "item", ty: type };
    frame.env = machine.environment(0);
    run(instruction);
    const item = machine.cell(frame.env, "item").value;
    if (iterable === list) assert.deepEqual(item, int(6));
    else assert.deepEqual(machine.getMember(item, "value", integer), int(5));
    run(instruction);
    assert.equal(frame.pc, 40);
    run({ op: "iter_end", id: 1 });
    assert.equal(Object.hasOwn(frame.iterators, 1), false);
  }
  for (const profile of ["bifoil-vm.v1", "bifoil-vm.v2"]) {
    machine.program.profile = profile;
    run({ op: "iter_start", id: 2 }, text("A😀"));
    const instruction = { op: "iter_next", id: 2, target: 50, name: "letter", ty: { kind: "char" } };
    for (const letter of ["A", "😀"]) {
      frame.env = machine.environment(0);
      run(instruction);
      assert.deepEqual(machine.cell(frame.env, "letter").value, value("char", letter));
    }
    run(instruction);
    assert.equal(frame.pc, 50);
  }
});

test("loop instructions terminate stepped ranges and restore stack and lexical scope boundaries", () => {
  const { machine, frame, run } = context();
  run({ op: "range", descending: false, exclusive: true }, int(1), int(6));
  run({ op: "range_step" }, int(2));
  const range = frame.stack.pop();
  assert.deepEqual([range.first, range.last, range.step], [1, 5, 2]);
  run({ op: "iter_start", id: 3 }, range);
  const instruction = { op: "iter_next", id: 3, name: "number", ty: integer, target: 19 };
  for (const number of [1, 3, 5]) {
    frame.env = machine.environment(0);
    run(instruction);
    assert.deepEqual(machine.cell(frame.env, "number").value, int(number));
  }
  run(instruction);
  assert.equal(frame.pc, 19);
  run({ op: "stack_mark", id: 0 });
  assert.throws(() => run({ op: "stack_mark", id: 0 }), /duplicate loop stack mark/);
  frame.stack.push(int(1));
  run({ op: "stack_mark", id: 1 });
  frame.stack.push(int(2));
  run({ op: "stack_reset", id: 0 });
  assert.deepEqual(frame.stack, []);
  assert.deepEqual(frame.loopMarks, [{ id: 0, depth: 0 }]);
  run({ op: "stack_end", id: 0 });
  assert.deepEqual(frame.loopMarks, []);
  frame.env = machine.environment(machine.environment(0));
  run({ op: "unwind", count: 2 });
  assert.equal(frame.env, 0);
  run({ op: "unwind", count: 0 });
  assert.equal(frame.env, 0);
});

test("scene transfers discard current function frames but preserve an earlier scene caller", () => {
  const { machine, frame, run } = context();
  const scene = { kind: "scene", id: machine.program.entry, env: 0 };
  const caller = { function: machine.program.entry, env: 0, pc: 5, stack: [], proseBase: 0 };
  const replaced = { ...caller, pc: 2 };
  const helper = { ...caller, function: "helpers.add" };
  machine.state.frames.push(caller, replaced, helper);
  run({ op: "scene_call", names: [], direct: true, transfer: true }, scene);
  assert.equal(machine.state.frames.length, 2);
  assert.equal(machine.state.frames[0], caller);
  assert.notEqual(machine.state.frames[1], replaced);
  assert.equal(machine.state.frames[1].function, scene.id);
  run({ op: "scene_call", names: [], direct: true, transfer: false }, scene);
  assert.equal(machine.state.frames.length, 3);
  machine.state.frames[1].proseBase = undefined;
  machine.state.frames.pop();
  run({ op: "scene_call", names: [], direct: true, transfer: true }, scene);
  assert.equal(machine.state.frames.length, 2);
  assert.equal(frame.stack.length, 0);
});
