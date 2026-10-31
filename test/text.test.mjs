import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scalarLength, scalarAt, scalarSubstring, scalarOrder, isSingleScalar } from "../src/text.mjs";
import { isScalarString } from "../src/values.mjs";
import { VM } from "../src/vm.mjs";
import { collectGarbage } from "../src/collector.mjs";

test("Unicode operations preserve scalar boundaries, combining marks and prefix ordering", () => {
  const samples = ["", "plain", "😀e\u0301", "\ue000𐀀", "\0😀\n"];
  for (const text of samples) {
    const elements = Array.from(text);
    assert.equal(scalarLength(text), elements.length);
    for (let start = 0; start <= elements.length; start++) {
      if (start < elements.length) assert.equal(scalarAt(text, start), elements[start]);
      for (let end = start; end <= elements.length; end++)
        assert.equal(scalarSubstring(text, start, end), elements.slice(start, end).join(""));
    }
    assert.throws(() => scalarAt(text, -1), /bounds/);
    assert.throws(() => scalarAt(text, elements.length), /bounds/);
    assert.throws(() => scalarSubstring(text, 0, elements.length + 1), /bounds/);
  }
  assert.equal(scalarOrder("😀", "\ue000"), 1);
  assert.equal(scalarOrder("a", "a😀"), -1);
  assert.equal(scalarOrder("a😀", "a"), 1);
  assert.equal(scalarOrder("😀e", "😀e"), 0);
  assert.equal(isScalarString("\ud800"), false);
  assert.equal(isScalarString("\udfff"), false);
  assert.equal(isSingleScalar("😀"), true);
  assert.equal(isSingleScalar("e\u0301"), false);
});

test("large Unicode values support validation and scalar access without a materialized traversal", () => {
  const text = "😀".repeat(200000) + "end";
  assert.equal(isScalarString(text), true);
  assert.equal(scalarLength(text), 200003);
  assert.equal(scalarAt(text, 199999), "😀");
  assert.equal(scalarSubstring(text, 200000, 200003), "end");
  assert.equal(isSingleScalar(text), false);
});

test("String traversal survives collection and checkpoints and rejects split-surrogate cursors", () => {
  const program = JSON.parse(readFileSync(new URL("./fixtures/unicode.json", import.meta.url), "utf8"));
  let machine = new VM(program),
    result = machine.run();
  collectGarbage(machine);
  const corrupt = JSON.parse(machine.save());
  const iterator = Object.values(corrupt.frames.at(-1).iterators).find((iterator) => iterator.kind === "string");
  iterator.offset = 2;
  assert.throws(() => VM.restore(program, JSON.stringify(corrupt)), /suspended traversal/);
  for (const character of ["A", "😀", "e", "\u0301"]) {
    assert.deepEqual(result.options, [{ label: "Append " + character, enabled: true }]);
    machine = VM.restore(program, machine.save());
    result = machine.choose(0);
  }
  assert.equal(result.status, "done");
  assert.deepEqual(result.output, ["A😀e\u0301"]);
});
