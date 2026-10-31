import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";

const int = { kind: "int" };
const string = { kind: "string" };
const named = (name, ...args) => ({ kind: "named", name, args });

function prepared() {
  const program = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  const parameter = { kind: "parameter", name: "T" };
  program.types = {
    "test.Box": {
      kind: "data",
      parameters: [{ name: "T", bounds: [] }],
      field_order: ["value", "next"],
      fields: {
        value: { ty: parameter, mutable: false, private: false },
        next: { ty: { kind: "nullable", inner: named("test.Box", parameter) }, mutable: true, private: false },
      },
      methods: {},
      variants: [],
    },
  };
  const machine = new VM(program);
  assert.equal(machine.run().status, "waiting");
  const type = named("test.Box", int);
  const fields = {};
  const box = machine.allocateObject({ kind: "data", type, fields, tag: null });
  fields.value =
    machine.state.cells.push({ ty: int, mutable: false, initialized: true, value: { kind: "int", value: 7 } }) - 1;
  fields.next =
    machine.state.cells.push({ ty: { kind: "nullable", inner: type }, mutable: true, initialized: true, value: box }) -
    1;
  machine.declare(0, "record", type, false, box);
  const entryType = named("Entry", int, string);
  const entry = machine.allocateObject({
    kind: "entry",
    type: entryType,
    key: { kind: "int", value: 1 },
    value: { kind: "string", value: "one" },
  });
  machine.declare(0, "entry", entryType, false, entry);
  return { program, checkpoint: JSON.parse(machine.save()) };
}

function record(state) {
  return state.objects.find((object) => object.kind === "data");
}

test("restoration retains generic field types, mutability, cyclic aliases, and traversal entries", () => {
  const { program, checkpoint } = prepared();
  const restored = VM.restore(program, JSON.stringify(checkpoint));
  const box = restored.cell(0, "record").value;
  const object = restored.object(box);
  assert.equal(restored.state.cells[object.fields.value].value.value, 7);
  assert.equal(restored.state.cells[object.fields.next].value.ref, box.ref);
  const entry = restored.object(restored.cell(0, "entry").value);
  assert.equal(entry.key.value, 1);
  assert.equal(entry.value.value, "one");
  assert.deepEqual(restored.choose(0).output, ["Result 12; counter 2; next 3; after 3."]);
});

test("restoration rejects changed nominal field contracts before executing the story", () => {
  for (const mutate of [
    (state) => {
      delete record(state).fields.value;
    },
    (state) => {
      record(state).fields.extra = record(state).fields.value;
    },
    (state) => {
      state.cells[record(state).fields.value].mutable = true;
    },
    (state) => {
      const cell = state.cells[record(state).fields.value];
      cell.ty = string;
      cell.value = { kind: "string", value: "wrong" };
    },
    (state) => {
      const cell = state.cells[record(state).fields.value];
      cell.initialized = false;
      cell.value = null;
    },
    (state) => {
      record(state).tag = "Invented";
    },
  ]) {
    const { program, checkpoint } = prepared();
    mutate(checkpoint);
    assert.throws(() => VM.restore(program, JSON.stringify(checkpoint)), /invalid checkpoint (nominal|field)/);
  }
});

test("restoration checks traversal entry types and collection representation", () => {
  for (const mutate of [
    (entry) => {
      entry.key = { kind: "string", value: "wrong" };
    },
    (entry) => {
      entry.value = { kind: "int", value: 2 };
    },
    (entry) => {
      entry.type = named("Entry", int);
    },
    (entry) => {
      entry.kind = "list";
      entry.items = [];
    },
  ]) {
    const { program, checkpoint } = prepared();
    const entry = checkpoint.objects.find((object) => object.kind === "entry");
    mutate(entry);
    // Keep reference metadata consistent: the object contract itself must fail.
    for (const cell of checkpoint.cells) {
      if (cell.value?.ref === checkpoint.objects.indexOf(entry)) {
        cell.ty = entry.type;
        cell.value = { kind: entry.kind, type: entry.type, ref: cell.value.ref };
      }
    }
    assert.throws(() => VM.restore(program, JSON.stringify(checkpoint)), /invalid checkpoint (entry|collection)/);
  }
});

test("primitive metadata cannot impersonate another saved value type", () => {
  const { program, checkpoint } = prepared();
  const cell = checkpoint.cells[record(checkpoint).fields.value];
  cell.value = { kind: "string", value: "wrong", type: int };
  assert.throws(() => VM.restore(program, JSON.stringify(checkpoint)), /invalid checkpoint cell/);
});

function machineAtCheckpoint() {
  const { program, checkpoint } = prepared();
  return VM.restore(program, JSON.stringify(checkpoint));
}

function retainKeys(machine, keys, type) {
  const setType = named("Set", type);
  machine.declare(0, "storedKeys", setType, false, machine.collectionValue(setType, keys));
}

function frozenCycle(machine, payload) {
  const type = named("test.Frozen");
  const payloadType = machine.valueType(payload);
  machine.program.types[type.name] = {
    kind: "data",
    parameters: [],
    field_order: ["next", "payload"],
    fields: {
      next: { ty: type, mutable: false, private: false },
      payload: { ty: payloadType, mutable: false, private: false },
    },
    methods: {},
    variants: [],
  };
  const fields = {};
  const node = machine.allocateObject({ kind: "data", type, fields, tag: null });
  fields.next = machine.state.cells.push({ ty: type, mutable: false, initialized: true, value: node }) - 1;
  fields.payload = machine.state.cells.push({ ty: payloadType, mutable: false, initialized: true, value: payload }) - 1;
  return node;
}

test("restoration rejects callable and mutable stored keys before replacing a host", () => {
  for (const keyValue of [
    (machine) => machine.cell(0, "$builtin.String").value,
    (machine) => machine.collectionValue(named("MutableList", int), [{ kind: "int", value: 1 }]),
    (machine) => machine.cell(0, "record").value,
  ]) {
    const machine = machineAtCheckpoint();
    const key = keyValue(machine);
    retainKeys(machine, [key], machine.valueType(key));
    const checkpoint = machine.save();
    let replaced = false;
    assert.throws(
      () =>
        VM.restore(machine.program, checkpoint, {
          beforeRestore: () => {
            replaced = true;
          },
        }),
      /checkpoint key.*stable equality/,
    );
    assert.equal(replaced, false);
  }
});

test("cyclic immutable keys survive restoration and mutable descendants are rejected", () => {
  const machine = machineAtCheckpoint();
  const node = frozenCycle(machine, { kind: "int", value: 7 });
  retainKeys(machine, [node], machine.valueType(node));
  const restored = VM.restore(machine.program, machine.save());
  const stored = restored.object(restored.cell(0, "storedKeys").value).items[0];
  const next = restored.state.cells[restored.object(stored).fields.next].value;
  assert.equal(stored.ref, next.ref);
  assert.equal(restored.equal(stored, next), true);
  assert.deepEqual(restored.choose(0).output, ["Result 12; counter 2; next 3; after 3."]);

  const changed = machineAtCheckpoint();
  const mutable = changed.collectionValue(named("MutableList", int), [{ kind: "int", value: 1 }]);
  const unstable = frozenCycle(changed, mutable);
  retainKeys(changed, [unstable], changed.valueType(unstable));
  assert.throws(() => VM.restore(changed.program, changed.save()), /checkpoint key.*stable equality/);
});

test("restoration rejects duplicate stored set elements and map keys", () => {
  for (const kind of ["set", "map", "zero"]) {
    const machine = machineAtCheckpoint();
    if (kind === "map") {
      const type = named("Map", int, int);
      machine.declare(
        0,
        "duplicates",
        type,
        false,
        machine.collectionValue(type, [
          [
            { kind: "int", value: 1 },
            { kind: "int", value: 3 },
          ],
          [
            { kind: "int", value: 1 },
            { kind: "int", value: 4 },
          ],
        ]),
      );
    } else {
      const element = kind === "zero" ? { kind: "float" } : int;
      retainKeys(
        machine,
        kind === "zero"
          ? [
              { kind: "float", value: -0 },
              { kind: "float", value: 0 },
            ]
          : [
              { kind: "int", value: 1 },
              { kind: "int", value: 1 },
            ],
        element,
      );
    }
    assert.throws(() => VM.restore(machine.program, machine.save()), /duplicate checkpoint (set element|map key)/);
  }
});
