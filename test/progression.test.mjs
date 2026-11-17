import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { spawnSync } from "node:child_process";

const integer = (value) => ({ kind: "int", value });
const progression = (first, last, step, name = "IntProgression") => ({
  kind: "range",
  type: { kind: "named", name, args: [] },
  first,
  last,
  step,
  empty: false,
});
function machine() {
  return new VM(JSON.parse(readFileSync(new URL("./fixtures/unicode.json", import.meta.url), "utf8")));
}

test("large progression membership preserves the search-index overflow boundary without linear traversal", () => {
  const vm = machine();
  const ascending = progression(-2147483648, 2147483647, 1);
  assert.equal(vm.contains(ascending, integer(-2147483648)), true);
  assert.equal(vm.contains(ascending, integer(-1)), true);
  assert.throws(() => vm.contains(ascending, integer(0)), /progression search index overflow/);
  const descending = progression(2147483647, -2147483648, -1);
  assert.equal(vm.contains(descending, integer(0)), true);
  assert.throws(() => vm.contains(descending, integer(-1)), /progression search index overflow/);
  const missing = progression(-2147483648, 2147483646, 1);
  assert.throws(() => vm.contains(missing, integer(2147483647)), /progression search index overflow/);
  assert.equal(vm.contains(progression(1, 5, -1), integer(3)), false);
  assert.equal(vm.contains(progression(5, 1, 1), integer(3)), false);
  const range = progression(-2147483648, 2147483647, 1, "IntRange");
  assert.equal(vm.contains(range, integer(2147483647)), true);
});

test("direct progression search agrees with ordered element traversal for small signed progressions", () => {
  const vm = machine();
  for (let first = -12; first <= 12; first++) {
    for (const step of [-7, -3, -1, 1, 3, 7]) {
      const values = Array.from({ length: 8 }, (_, index) => first + step * index);
      const range = progression(first, values.at(-1), step);
      for (let target = -70; target <= 70; target++)
        assert.equal(vm.contains(range, integer(target)), values.includes(target));
    }
  }
});

test("checkpoints preserve progression invariants and reject malformed range tags and endpoints", () => {
  const vm = machine();
  const range = progression(1, 9, 2);
  vm.declare(0, "savedRange", range.type, false, range);
  assert.equal(vm.run().status, "waiting");
  const checkpoint = vm.save();
  assert.equal(VM.restore(vm.program, checkpoint).cell(0, "savedRange").value.last, 9);
  for (const mutate of [
    (item) => {
      item.type = { kind: "named", name: "Other", args: [] };
    },
    (item) => {
      item.type = { kind: "named", name: "IntRange", args: [] };
    },
    (item) => {
      item.last = 8;
    },
    (item) => {
      item.empty = true;
    },
    (item) => {
      item.step = 0;
    },
  ]) {
    const invalid = JSON.parse(checkpoint);
    const cell = invalid.cells.find((cell) => cell.value?.kind === "range");
    mutate(cell.value);
    cell.ty = cell.value.type;
    assert.throws(() => VM.restore(vm.program, JSON.stringify(invalid)), /invalid checkpoint cell/);
  }
});

test("the last valid search index can exhaust without a spurious overflow check", () => {
  const vm = machine();
  for (const [range, last, absent] of [
    [progression(-2147483648, -1, 1), -1, 0],
    [progression(2147483647, 0, -1), 0, -1],
    [progression(-2147483648, 2147483646, 2), 2147483646, 2147483647],
    [progression(2147483647, -2147483647, -2), -2147483647, -2147483648],
  ]) {
    assert.equal(vm.contains(range, integer(last)), true);
    assert.equal(vm.contains(range, integer(absent)), false);
  }
  for (const [range, next, absent] of [
    [progression(-2147483648, 0, 1), 0, 1],
    [progression(2147483647, -1, -1), -1, -2],
  ]) {
    assert.throws(() => vm.contains(range, integer(next)), /progression search index overflow/);
    assert.throws(() => vm.contains(range, integer(absent)), /progression search index overflow/);
    assert.equal(vm.contains(range, integer(range.first)), true);
  }
});

test("full-domain membership finishes under an external deadline without enumerating the domain", () => {
  const vmUrl = new URL("../src/vm.mjs", import.meta.url).href;
  const fixture = new URL("./fixtures/unicode.json", import.meta.url).href;
  const script = `
    import { readFileSync } from "node:fs";
    import { VM } from ${JSON.stringify(vmUrl)};
    const machine = new VM(JSON.parse(readFileSync(new URL(${JSON.stringify(fixture)}), "utf8")));
    const range = { kind: "range", type: { kind: "named", name: "IntProgression", args: [] },
      first: -2147483648, last: 2147483647, step: 1, empty: false };
    const result = [-2147483648, -1, 0].map(value => {
      try { return machine.contains(range, { kind: "int", value }); }
      catch (error) { return error.message; }
    });
    console.log(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 4096,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [true, true, "progression search index overflow"]);
});
