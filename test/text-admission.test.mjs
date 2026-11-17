import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_TEXT_UNITS, assertScalarText, textIssue, joinText } from "../src/text.mjs";
import { fromLegacy } from "../src/legacy/values.mjs";
import { validateLegacyOptions } from "../src/legacy.mjs";
import { binary } from "../src/numeric.mjs";
import { stringify } from "../src/rendering.mjs";
import { executeInstruction } from "../src/operations.mjs";
import { value } from "../src/values.mjs";
import { VM } from "../src/vm.mjs";

const string = { kind: "string" };
const fixture = (name) => JSON.parse(readFileSync(new URL("./fixtures/" + name + ".json", import.meta.url), "utf8"));

test("external text reports scalar and storage positions without echoing private contents", () => {
  for (const [text, scalar, offset] of [
    ["secret😀e\ud800", 8, 9],
    ["😀\udc00", 1, 2],
    ["\ud800", 0, 0],
  ]) {
    const expected = "unpaired surrogate at scalar index " + scalar + " (UTF-16 offset " + offset + ")";
    assert.equal(textIssue(text), expected);
    assert.throws(
      () => fromLegacy(text, string),
      (error) => {
        assert.equal(error.message, "legacy text is not a Unicode scalar String: " + expected);
        assert.ok(!error.message.includes("secret"));
        return true;
      },
    );
  }
  assert.equal(assertScalarText("\0😀e\u0301"), "\0😀e\u0301");
  assert.match(textIssue(3), /must be a String/);
});

test("external admission rejects size before scanning malformed contents and retains the exact boundary", () => {
  const exact = "😀".repeat(MAX_TEXT_UNITS / 2);
  assert.strictEqual(fromLegacy(exact, string).value, exact);
  // The size diagnostic wins over a surrogate at the beginning or end.
  for (const text of ["\ud800" + exact, exact + "\udc00"])
    assert.throws(() => fromLegacy(text, string), /text size budget exceeded/);
  assert.equal(joinText([exact, ""]), exact);
  assert.throws(() => joinText([exact, ""], " "), /text size budget exceeded/);
});

test("concatenation, interpolation pieces, rendering and prose reject before combining oversized results", () => {
  const half = "x".repeat(MAX_TEXT_UNITS / 2);
  assert.equal(binary("+", value("string", half), value("string", half)).value.length, MAX_TEXT_UNITS);
  assert.throws(() => binary("+", value("string", half), value("string", half + "x")), /text size budget exceeded/);
  assert.throws(() => joinText([half, half, "x"]), /text size budget exceeded/);
  const machine = {
    program: { profile: "bifoil-vm.v3", types: {} },
    object() {
      return { items: [value("string", half), value("string", half)] };
    },
    state: { prose: [half] },
  };
  assert.throws(() => stringify(machine, { kind: "list", ref: 0 }), /text size budget exceeded/);
  assert.throws(
    () => executeInstruction(machine, { op: "prose_text" }, { stack: [] }, () => value("string", half)),
    /text size budget exceeded/,
  );
  assert.strictEqual(machine.state.prose[0], half);
});

test("checkpoint presentation text rejects malformed scalars before restoring any external host", () => {
  const program = fixture("legacy");
  const legacy = {
    read() {
      return 0;
    },
    write() {},
    start() {
      return { status: "waiting", options: [{ label: "Continue", enabled: true }], continuation: null };
    },
    snapshot() {
      return null;
    },
    restores: 0,
    restore() {
      this.restores++;
    },
  };
  const machine = new VM(program, null, { legacy });
  machine.run();
  const original = JSON.parse(machine.save());
  const corruptions = [
    (state) => {
      state.transcript.push("secret\ud800");
    },
    (state) => {
      state.prose.push("\ud800");
    },
    (state) => {
      state.pending.options[0].label = "\ud800";
    },
  ];
  for (const corrupt of corruptions) {
    const state = structuredClone(original);
    corrupt(state);
    assert.throws(() => VM.restore(program, JSON.stringify(state), { legacy }), /unpaired surrogate/);
    assert.equal(legacy.restores, 0);
  }
  assert.throws(
    () => validateLegacyOptions([{ label: "\udc00", enabled: true }]),
    /legacy option label.*scalar index 0/,
  );
});

test("malformed input leaves the prepared wait reusable and never calls the native host", () => {
  let resumes = 0;
  const legacy = {
    read() {
      return 0;
    },
    write() {},
    start() {
      return {
        status: "waiting",
        options: [],
        continuation: null,
        input: { kind: "text", long: false, allow_blank: false },
      };
    },
    resume() {
      resumes++;
      return { status: "returned", value: 3 };
    },
  };
  const machine = new VM(fixture("legacy"), null, { legacy });
  assert.equal(machine.run().status, "waiting");
  const pending = machine.state.pending;
  assert.throws(() => machine.submit("secret\ud800"), /input text.*scalar index 6/);
  assert.strictEqual(machine.state.pending, pending);
  assert.equal(machine.failure, undefined);
  assert.equal(resumes, 0);
  machine.submit("Valid 😀");
  assert.equal(resumes, 1);
});

test("malformed legacy output fails at the Bifoil call span while retaining only completed output", () => {
  const legacy = {
    read() {
      return 0;
    },
    write() {},
    start() {
      return { status: "returned", value: 3, output: ["Completed", "secret\ud800"] };
    },
  };
  const machine = new VM(fixture("legacy"), null, { legacy });
  assert.throws(
    () => machine.run(),
    (error) => {
      assert.match(error.message, /src\/main\.bfl:2: output text: unpaired surrogate at scalar index 6/);
      assert.ok(!error.message.includes("secret"));
      return true;
    },
  );
  assert.deepEqual(machine.drainOutput(), ["Completed"]);
  assert.deepEqual(machine.drainOutput(), []);
});
