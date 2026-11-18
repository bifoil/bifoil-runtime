import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { collectGarbage } from "../src/collector.mjs";

const named = (name, ...args) => ({ kind: "named", name, args });
const int = { kind: "int" },
  boolean = { kind: "boolean" },
  unit = { kind: "unit" };
const keyType = named("List", int),
  mapType = named("MutableMap", keyType, int);
const entryType = named("Entry", keyType, int);
const span = { file: "src/collection.bfl", line: 1 };
const constant = (value, ty = int) => ({ op: "constant", ty, value });
const printTop = [{ op: "format", count: 1 }, { op: "print" }];

function program() {
  const program = JSON.parse(readFileSync(new URL("./fixtures/unicode.json", import.meta.url), "utf8"));
  const code = [
    { op: "begin_collection", ty: mapType },
    { op: "begin_collection", ty: keyType },
    constant(1),
    { op: "collection_add" },
    constant(10),
    { op: "collection_put" },
    { op: "declare", name: "mapping", ty: mapType, mutable: false },
    // The second key is owned only by the suspended assignment address.
    { op: "load", name: "mapping" },
    { op: "begin_collection", ty: keyType },
    constant(2),
    { op: "collection_add" },
    { op: "address_index" },
    constant(1),
    constant(3),
    { op: "range", descending: false, exclusive: false },
    { op: "iter_start", id: 1 },
    constant("a😀", { kind: "string" }),
    { op: "iter_start", id: 2 },
    { op: "load", name: "mapping" },
    { op: "iter_start", id: 3 },
    { op: "load", name: "mapping" },
    {
      op: "member",
      name: "isEmpty",
      function: "$builtin.isEmpty",
      ty: { kind: "function", params: [], result: boolean, suspend: false },
    },
    {
      op: "declare",
      name: "empty",
      ty: { kind: "function", params: [], result: boolean, suspend: false },
      mutable: false,
    },
    { op: "begin_choice" },
    constant(true, boolean),
    constant("Continue", { kind: "string" }),
    { op: "offer", target: 0 },
    { op: "choose", fallback: null },
    constant(77),
    { op: "write_address" },
    { op: "load", name: "empty" },
    { op: "call", names: [], direct: false },
    ...printTop,
    { op: "iter_next", id: 1, name: "number", ty: int, target: 0 },
    { op: "load", name: "number" },
    ...printTop,
    { op: "iter_next", id: 2, name: "letter", ty: { kind: "char" }, target: 0 },
    { op: "load", name: "letter" },
    ...printTop,
    { op: "iter_next", id: 3, name: "entry", ty: entryType, target: 0 },
    { op: "load", name: "entry" },
    { op: "member", name: "key", ty: keyType },
    constant(0),
    { op: "index" },
    ...printTop,
    { op: "load", name: "mapping" },
    { op: "member", name: "size", ty: int },
    ...printTop,
    constant(null, unit),
    { op: "return" },
  ];
  const resume = code.findIndex((instruction) => instruction.op === "choose") + 1;
  code.find((instruction) => instruction.op === "offer").target = resume;
  for (const instruction of code) if (instruction.op === "iter_next") instruction.target = code.length - 2;
  program.functions = {
    [program.entry]: {
      signature: { id: program.entry, params: [], result: unit, suspend: true, scene: true },
      init: false,
      local: false,
      code: code.map((instruction) => ({ ...instruction, span })),
    },
  };
  return program;
}

test("collection relocates live assignment keys, bound receivers and all traversal families before restore", () => {
  const input = program();
  const machine = new VM(input);
  machine.collectionValue(keyType, [{ kind: "int", value: 999 }]);
  const discarded = machine.environment(0);
  machine.declare(discarded, "unused", int, false, { kind: "int", value: 999 });
  assert.equal(machine.run().status, "waiting");
  const address = machine.state.frames[0].stack[0];
  const previousKey = address.key.ref;
  const previousReceiver = machine.cell(machine.state.frames[0].env, "empty").value.receiver;
  const reclaimed = collectGarbage(machine);
  assert.equal(reclaimed.objects, 1);
  assert.ok(reclaimed.cells >= 1);
  assert.ok(address.key.ref < previousKey);
  assert.ok(machine.cell(machine.state.frames[0].env, "empty").value.receiver < previousReceiver);
  const restored = VM.restore(input, machine.save());
  const result = restored.choose(0);
  assert.equal(result.status, "done");
  assert.deepEqual(result.output, ["false", "1", "a", "1", "2"]);
});
