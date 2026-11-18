import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";

const integer = (value) => ({ kind: "int", value });
const progression = {
  kind: "range",
  type: { kind: "named", name: "IntProgression", args: [] },
  first: 1,
  last: 5,
  step: 2,
  empty: false,
};

function checkpoint() {
  const program = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  const machine = new VM(program);
  assert.equal(machine.run().status, "waiting");
  return { program, state: JSON.parse(machine.save()) };
}

test("saved traversal cursors retain collection, scalar-text, and progression state through a choice", () => {
  for (const iterator of [
    { items: [integer(1)], index: 0 },
    { items: [integer(1)], index: 1 },
    { kind: "string", text: "a😀", offset: 1 },
    { kind: "string", text: "a😀", offset: 3 },
    { range: progression, current: 3, done: false },
    { range: progression, current: 5, done: true },
  ]) {
    const { program, state } = checkpoint();
    state.frames.at(-1).iterators = { original: iterator };
    const restored = VM.restore(program, JSON.stringify(state));
    assert.deepEqual(restored.state.frames.at(-1).iterators.original, iterator);
    assert.deepEqual(restored.choose(0).output, ["Result 12; counter 2; next 3; after 3."]);
  }
});

test("malformed saved traversal cursors fail before a choice can resume", () => {
  for (const iterator of [
    null,
    { range: { ...progression, step: 0 }, current: 1, done: false },
    { range: integer(1), current: 1, done: false },
    { range: progression, current: 1.5, done: false },
    { range: progression, current: 1, done: "false" },
    { kind: "string", text: "a\ud800", offset: 0 },
    { kind: "string", text: "a😀", offset: 2 },
    { items: {}, index: 0 },
    { items: [null], index: 0 },
    { items: [integer(1)], index: 0.5 },
    { items: [integer(1)], index: -1 },
    { items: [integer(1)], index: 2 },
  ]) {
    const { program, state } = checkpoint();
    state.frames.at(-1).iterators = { original: iterator };
    assert.throws(() => VM.restore(program, JSON.stringify(state)), /invalid suspended traversal/);
  }
});

test("optional once identities survive restoration but invalid identities and disabled waits fail", () => {
  for (const once of [null, "original-once"]) {
    const { program, state } = checkpoint();
    state.frames.at(-1).choice[0].once = once;
    state.pending.options[0].once = once;
    const restored = VM.restore(program, JSON.stringify(state));
    assert.deepEqual(restored.choose(0).output, ["Result 12; counter 2; next 3; after 3."]);
  }
  for (const mutate of [
    (state) => {
      state.frames.at(-1).choice[0].once = 12;
    },
    (state) => {
      state.pending.options.forEach((option) => {
        option.enabled = false;
      });
    },
    (state) => {
      state.boot = ["missing.initializer"];
    },
    (state) => {
      state.pending.kind = "legacy";
      state.frames.at(-1).pc = 0;
    },
  ]) {
    const { program, state } = checkpoint();
    mutate(state);
    assert.throws(
      () => VM.restore(program, JSON.stringify(state)),
      /invalid choice option|invalid choice snapshot|invalid checkpoint initialization|invalid legacy input continuation/,
    );
  }
});
