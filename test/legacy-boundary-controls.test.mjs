import test from "node:test";
import assert from "node:assert/strict";
import { submitInput } from "../src/legacy/input.mjs";
import { boundaryType, toLegacy } from "../src/legacy/values.mjs";
import { encodeState, decodeState } from "../src/legacy/state.mjs";
import { installOutput } from "../src/legacy/output.mjs";

test("native numeric submissions retain prepared bounds and feedback until a valid response", () => {
  const writes = [],
    resets = [];
  const scene = { nav: { bugLog: [] }, setVar: (...args) => writes.push(args), resetPage: () => resets.push(true) };
  const wait = {
    variable: "answer",
    input: {
      kind: "number",
      minimum: "2",
      maximum: "5",
      integer: true,
      allow_blank: false,
    },
  };
  for (const [response, feedback] of [
    ["", "Don't just leave it blank! Type something!"],
    ["invalid", "Please type in a number."],
    ["2.5", "Please type in an integer number."],
    ["1", "Please use a number greater than or equal to 2"],
    ["6", "Please use a number less than or equal to 5"],
  ]) {
    const call = {};
    submitInput(scene, call, wait, response);
    assert.deepEqual(call.wait, { ...wait, input: { ...wait.input, feedback } });
    assert.equal(writes.length, 0);
    assert.equal(resets.length, 0);
    assert.deepEqual(scene.nav.bugLog, []);
  }
  submitInput(scene, {}, wait, "3");
  assert.deepEqual(writes, [["answer", 3]]);
  assert.deepEqual(scene.nav.bugLog, ["*input_number answer 3"]);
  assert.equal(scene.finished, false);
  assert.equal(resets.length, 1);
});

test("native text submissions log the normalized value and accept explicitly allowed blanks", () => {
  const writes = [];
  const scene = { nav: { bugLog: [] }, setVar: (...args) => writes.push(args), resetPage() {} };
  const wait = { variable: "name", input: { kind: "text", long: true, allow_blank: true } };
  submitInput(scene, {}, wait, "  Original\nwords.  ");
  submitInput(scene, {}, wait, "");
  assert.deepEqual(writes, [
    ["name", "Original[n/]words."],
    ["name", ""],
  ]);
  assert.deepEqual(scene.nav.bugLog, ["*input_text name Original[n/]words.", "*input_text name "]);
});

test("headless native input commits without a navigation log", () => {
  const writes = [];
  let resets = 0;
  const scene = { setVar: (...args) => writes.push(args), resetPage: () => resets++ };
  submitInput(scene, {}, { variable: "answer", input: { kind: "text", allow_blank: false } }, "  Original  ");
  assert.deepEqual(writes, [["answer", "Original"]]);
  assert.equal(resets, 1);
  assert.equal(scene.finished, false);
});

test("enum boundary descriptors require closed non-generic definitions and plain empty fields", () => {
  const type = { kind: "named", name: "original.Signal" };
  const definition = { kind: "enum", fields: {}, variants: ["original.Signal.Ready"] };
  const definitions = { [type.name]: definition };
  assert.equal(boundaryType(type, false, definitions), true);
  assert.equal(boundaryType({ kind: "nullable", inner: type }, false, definitions), true);
  assert.equal(boundaryType({ kind: "unit" }, true), true);
  for (const args of ["invalid", {}, [type]]) assert.equal(boundaryType({ ...type, args }, false, definitions), false);
  for (const change of [{ parameters: "invalid" }, { parameters: ["T"] }, { fields: [] }, { fields: null }])
    assert.equal(boundaryType(type, false, { [type.name]: { ...definition, ...change } }), false);
  assert.equal(boundaryType(undefined), false);
  assert.equal(boundaryType(type, false, null), false);
  const object = { kind: "data", type, fields: {}, tag: "Ready" };
  const machine = { program: { types: definitions }, object: () => object };
  const item = { kind: "data", id: 1 };
  assert.equal(toLegacy(item, type, machine), "Ready");
  for (const fields of [null, []]) {
    object.fields = fields;
    assert.throws(() => toLegacy(item, type, machine), /enum argument type mismatch/);
  }
});

test("native graph values preserve scalar roots and reject non-array reference envelopes", () => {
  for (const value of [null, -Infinity, true, "Original."]) assert.equal(decodeState(encodeState(value)), value);
  for (const value of [null, true, 1, {}])
    assert.throws(() => decodeState({ format: "bifoil.legacy-state.v1", nodes: [], root: value }), /graph value/);
  assert.throws(
    () => decodeState({ format: "bifoil.legacy-state.v1", nodes: [], root: ["unrecognized"] }),
    /unknown native graph value/,
  );
});

test("native rendering wrappers flush only when rendering can bypass buffered paragraphs", () => {
  const calls = [];
  const scene = { accumulatedParagraph: [] };
  const prototype = {
    image(...args) {
      assert.equal(this, scene);
      calls.push(["image", ...args]);
      return 7;
    },
    line_break() {
      assert.equal(this, scene);
      calls.push(["break"]);
    },
  };
  const call = { host: { Scene: { prototype }, publishOutput: (output) => calls.push(["publish", output]) } };
  installOutput(scene, call);
  assert.equal(scene.image("original.png"), 7);
  scene.line_break();
  scene.accumulatedParagraph.push("Buffered.");
  scene.line_break();
  assert.deepEqual(calls, [["publish", []], ["image", "original.png"], ["publish", []], ["break"], ["break"]]);
  const withoutBreak = {};
  installOutput(withoutBreak, { host: { Scene: { prototype: {} }, publishOutput() {} } });
  assert.equal(withoutBreak.line_break, undefined);
});
