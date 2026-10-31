import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";

const int = { kind: "int" };
const string = { kind: "string" };
const callable = (type) => ({ kind: "function", params: [type], result: type, suspend: false });

function prepared(generic = false, widen = false) {
  const program = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  if (generic) {
    const parameter = { kind: "parameter", name: "test.identity#T" };
    const span = { file: "src/callables.bfl", line: 1 };
    program.functions["test.identity"] = {
      signature: {
        id: "test.identity",
        generics: [{ name: parameter.name, bounds: [] }],
        params: [{ name: "item", ty: parameter, mutable: false, default: false }],
        result: parameter,
        suspend: false,
        scene: false,
      },
      code: [
        { op: "load", name: "item", span },
        { op: "return", span },
      ],
      init: false,
    };
  }
  const machine = new VM(program);
  assert.equal(machine.run().status, "waiting");
  const id = generic ? "test.identity" : "helpers.add";
  const original = machine.cell(0, id);
  const value = structuredClone(original.value);
  let type = original.ty;
  if (generic) {
    value.typeArgs = { "test.identity#T": int };
    value.type = type = callable(int);
  }
  if (widen) {
    value.type = type = { ...type, result: { kind: "any" } };
  }
  machine.declare(0, "selected", type, false, value);
  return { program, checkpoint: JSON.parse(machine.save()) };
}

function selected(state) {
  return state.cells[state.envs[0].bindings.selected];
}

test("stored functions retain declared, generic, and safely widened signature views", () => {
  for (const [generic, widen] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ]) {
    const { program, checkpoint } = prepared(generic, widen);
    const restored = VM.restore(program, JSON.stringify(checkpoint));
    const cell = restored.cell(0, "selected");
    assert.equal(restored.validValue(cell.value), true);
    const intrinsic = generic ? callable(int) : restored.functionType(program.functions[cell.value.id].signature);
    assert.deepEqual(restored.valueType(cell.value), intrinsic);
    assert.equal(restored.acceptsType(cell.ty, intrinsic), true);
    if (widen) assert.notDeepEqual(intrinsic, cell.ty);
    assert.deepEqual(restored.choose(0).output, ["Result 12; counter 2; next 3; after 3."]);
  }
});

test("restoration rejects exposed function signatures incompatible with their compiled targets", () => {
  for (const alter of [
    (type) => ({ ...type, result: string }),
    (type) => ({ ...type, params: [{ kind: "float" }] }),
    (type) => ({ ...type, vararg: true }),
    (type) => ({ kind: "scene", params: type.params }),
    () => ({ kind: "function", params: null }),
  ]) {
    const { program, checkpoint } = prepared();
    const cell = selected(checkpoint);
    // Change both annotations so ordinary cell assignment checks cannot mask
    // the mismatch with the function's independently compiled declaration.
    cell.ty = cell.value.type = alter(cell.ty);
    assert.throws(() => VM.restore(program, JSON.stringify(checkpoint)), /invalid checkpoint cell/);
  }
});

test("restoration validates retained generic argument descriptors and their exposed signature", () => {
  for (const typeArgs of [
    null,
    [],
    { "test.identity#T": "Int" },
    { "test.identity#T": { kind: "named", name: "List", args: null } },
    { "test.identity#T": string },
  ]) {
    const { program, checkpoint } = prepared(true);
    selected(checkpoint).value.typeArgs = typeArgs;
    assert.throws(() => VM.restore(program, JSON.stringify(checkpoint)), /invalid checkpoint cell/);
  }
});

test("an ordinary function retains its intrinsic effect through a suspend view", () => {
  const { program, checkpoint } = prepared(true);
  const cell = selected(checkpoint);
  cell.ty = cell.value.type = { ...cell.ty, suspend: true };
  const restored = VM.restore(program, JSON.stringify(checkpoint));
  const actual = restored.valueType(restored.cell(0, "selected").value);
  assert.equal(actual.suspend, false);
  assert.equal(restored.acceptsType(cell.ty, actual), true);

  program.functions["test.identity"].signature.suspend = true;
  cell.ty = cell.value.type = { ...cell.ty, suspend: false };
  assert.throws(() => VM.restore(program, JSON.stringify(checkpoint)), /invalid checkpoint cell/);
});
