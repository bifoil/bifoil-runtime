import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";

const int = { kind: "int" };
const string = { kind: "string" };
const parameter = { kind: "parameter", name: "test.wait#T" };

function prepared() {
  const program = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  const span = { file: "src/callables.bfl", line: 1 };
  program.functions["test.wait"] = {
    signature: {
      id: "test.wait",
      generics: [{ name: parameter.name, bounds: [] }],
      params: [{ name: "item", ty: parameter, mutable: false, default: false }],
      result: parameter,
      suspend: true,
      scene: false,
    },
    init: false,
    // Present a choice, print the retained generic argument, then return it.
    code: [
      { op: "begin_choice" },
      { op: "constant", ty: { kind: "boolean" }, value: true },
      { op: "constant", ty: string, value: "Continue" },
      { op: "offer", target: 5 },
      { op: "choose", fallback: null },
      { op: "load", name: "item" },
      { op: "format", count: 1 },
      { op: "print" },
      { op: "load", name: "item" },
      { op: "return" },
    ].map((instruction) => ({ ...instruction, span })),
  };
  const machine = new VM(program);
  machine.pushCall(
    { kind: "function", id: "test.wait", env: 0, typeArgs: { [parameter.name]: int } },
    [{ kind: "int", value: 7 }],
    [null],
    { direct: false },
  );
  assert.equal(machine.run().status, "waiting");
  return { program, checkpoint: JSON.parse(machine.save()) };
}

function argument(state) {
  const frame = state.frames.at(-1);
  return state.cells[state.envs[frame.env].bindings.item];
}

test("active generic calls retain their declared parameter contract across restoration", () => {
  const { program, checkpoint } = prepared();
  let machine = VM.restore(program, JSON.stringify(checkpoint));
  let result = machine.choose(0);
  const output = [...result.output];
  while (result.status === "waiting") {
    machine = VM.restore(program, machine.save());
    result = machine.choose(0);
    output.push(...result.output);
  }
  assert.equal(result.status, "done");
  assert.deepEqual(output, ["7", "Result 12; counter 2; next 3; after 3."]);
});

test("restoration rejects missing and malformed active generic arguments", () => {
  for (const typeArgs of [null, [], {}, { [parameter.name]: "Int" }]) {
    const { program, checkpoint } = prepared();
    checkpoint.frames.at(-1).typeArgs = typeArgs;
    assert.throws(() => VM.restore(program, JSON.stringify(checkpoint)), /saved call type argument/);
  }
});

test("active parameter cells must match the restored invocation rather than a replacement annotation", () => {
  for (const mutate of [
    (state) => {
      state.frames.at(-1).typeArgs[parameter.name] = string;
    },
    (state) => {
      const cell = argument(state);
      cell.ty = string;
      cell.value = { kind: "string", value: "changed" };
    },
    (state) => {
      argument(state).mutable = true;
    },
    (state) => {
      const cell = argument(state);
      cell.initialized = false;
      cell.value = null;
    },
    (state) => {
      delete state.envs[state.frames.at(-1).env].bindings.item;
    },
  ]) {
    const { program, checkpoint } = prepared();
    mutate(checkpoint);
    assert.throws(() => VM.restore(program, JSON.stringify(checkpoint)), /saved call parameter item/);
  }
});
