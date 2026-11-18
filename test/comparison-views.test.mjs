import test from "node:test";
import assert from "node:assert/strict";
import { VM } from "../src/vm.mjs";
import { loadPackage } from "../src/packages.mjs";
import { packageCodeStats } from "../src/program-code.mjs";
import { ComparisonViews } from "../src/comparison-views.mjs";
import { splitCompiledProgram } from "./support/packages.mjs";

const named = (name, ...args) => ({ kind: "named", name, args });
const intType = { kind: "int" },
  anyType = { kind: "any" },
  star = { kind: "star" };
const integer = (value) => ({ kind: "int", value });
const optional = (inner) => ({ kind: "nullable", inner });
const parameter = { kind: "parameter", name: "T" };
const field = (ty) => ({ ty, mutable: false, private: false });
const definition = (fields, parameters = []) => ({
  kind: "data",
  fields,
  parameters,
  field_order: Object.keys(fields),
  methods: {},
  private_methods: [],
  parent: null,
  variants: [],
});
const generic = [{ name: "T", variance: 1, bounds: [] }];
const box = (type) => named("example.Box", type);
const outer = (type) => named("example.Outer", type);
const span = { file: "src/views.bfl", line: 1 };

function program() {
  return {
    format: "bifoil.program.v2",
    profile: "bifoil-vm.v3",
    build: "a".repeat(64),
    entry: "example.start",
    modules: { example: "b".repeat(64) },
    init: [],
    types: {
      "example.Box": definition({ number: field(intType) }, generic),
      "example.Outer": definition({ item: field(parameter) }, generic),
      "example.Pair": definition({ wide: field(outer(box(anyType))), hidden: field(outer(star)) }),
      "example.Node": definition(
        { number: field(intType), next: { ...field(optional(named("example.Node", anyType))), mutable: true } },
        generic,
      ),
    },
    functions: {
      "example.start": {
        signature: { id: "example.start", params: [], result: { kind: "unit" }, suspend: true, scene: true },
        init: false,
        local: false,
        code: [
          { op: "constant", ty: { kind: "unit" }, value: null, span },
          { op: "return", span },
        ],
      },
    },
  };
}
function record(machine, type, values) {
  const definition = machine.program.types[type.name];
  const typeArgs = Object.fromEntries((definition.parameters ?? []).map((p, i) => [p.name, type.args[i]]));
  const fields = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      machine.state.cells.push({
        ty: machine.resolveType(definition.fields[name].ty, { typeArgs }),
        mutable: definition.fields[name].mutable,
        initialized: true,
        value,
      }) - 1,
    ]),
  );
  return machine.allocateObject({ kind: "data", type, fields });
}
const compare = (machine, a, b, left, right = left) => machine.exactCompare(a, b, left, right);

test("symbolic comparison-view identity preserves parameter names and non-null refinement", () => {
  const machine = new VM(program());
  const views = new ComparisonViews(machine);
  const symbolic = { kind: "parameter", name: "T" };
  assert.equal(views.identity(symbolic), views.identity({ ...symbolic, nonnull: false }));
  assert.notEqual(views.identity(symbolic), views.identity({ ...symbolic, nonnull: true }));
  assert.notEqual(views.identity(symbolic), views.identity({ ...symbolic, name: "U" }));
  assert.deepEqual(views.effective(undefined, integer(3)), intType);
});

test("legacy field views accept omitted generic metadata and leave unknown owners untyped", () => {
  const input = program();
  const plain = definition({ number: field(intType) });
  delete plain.parameters;
  input.types["legacy.Plain"] = plain;
  const machine = new VM(input);
  const views = new ComparisonViews(machine);
  const value = record(machine, named("legacy.Plain"), { number: integer(3) });
  assert.deepEqual(views.child(named("legacy.Plain"), machine.object(value), "number"), intType);
  assert.equal(views.child(named("legacy.Plain"), machine.object(value), "absent"), undefined);
  const unknownOwner = { kind: "data", type: named("legacy.Unavailable"), fields: {} };
  assert.equal(views.child(unknownOwner.type, unknownOwner, "number"), undefined);
  assert.deepEqual(views.effective(undefined, integer(4)), intType);
});

test("declared covariant views compare exactly without replacing construction identities", () => {
  const machine = new VM(program());
  const source = record(machine, box(intType), { number: integer(3) });
  const constructed = record(machine, box(anyType), { number: integer(3) });
  assert.equal(compare(machine, source, constructed, box(anyType)), true);
  assert.equal(compare(machine, source, constructed, box(intType), box(anyType)), false);
  assert.equal(machine.acceptsType(box(intType), machine.valueType(source)), true);
  assert.equal(machine.acceptsType(box(intType), machine.valueType(constructed)), false);
  assert.equal(machine.equal(source, constructed, true), false, "old-profile comparison retains its behavior");
});

test("empty nullable-element views do not infer new construction arguments from contents", () => {
  const machine = new VM(program());
  const source = machine.collectionValue(named("List", intType));
  const requested = named("List", optional(intType));
  const constructed = machine.collectionValue(requested);
  assert.equal(compare(machine, source, constructed, requested), true);
  assert.deepEqual(machine.valueType(source), named("List", intType));
  assert.deepEqual(machine.valueType(constructed), requested);
  assert.equal(compare(machine, source, constructed, source.type, constructed.type), false);
});

test("recursive container and field comparisons use the exposed field types", () => {
  const machine = new VM(program());
  const first = record(machine, box(intType), { number: integer(3) });
  const second = record(machine, box(anyType), { number: integer(3) });
  const left = record(machine, outer(box(intType)), { item: first });
  const right = record(machine, outer(box(anyType)), { item: second });
  assert.equal(compare(machine, left, right, outer(box(anyType))), true);
  const list = machine.collectionValue(named("List", left.type), [left]);
  const other = machine.collectionValue(named("List", right.type), [right]);
  assert.equal(compare(machine, list, other, named("List", outer(box(anyType)))), true);
});

test("comparison-pair memoization distinguishes a wide proof from a hidden payload view", () => {
  const machine = new VM(program());
  const first = record(machine, box(intType), { number: integer(3) });
  const second = record(machine, box(anyType), { number: integer(3) });
  const left = record(machine, outer(first.type), { item: first });
  const right = record(machine, outer(second.type), { item: second });
  assert.equal(compare(machine, left, right, outer(box(anyType))), true);
  assert.equal(compare(machine, left, right, outer(star)), false);
  const pairType = named("example.Pair");
  const a = record(machine, pairType, { wide: left, hidden: left });
  const b = record(machine, pairType, { wide: right, hidden: right });
  assert.equal(compare(machine, a, b, pairType), false);
});

test("unordered exact comparison rolls back failed trials with their view context", () => {
  const machine = new VM(program());
  const left = [1, 2].map((n) => record(machine, box(intType), { number: integer(n) }));
  const right = [2, 1].map((n) => record(machine, box(anyType), { number: integer(n) }));
  for (const family of ["Set", "Map"]) {
    const make = (items, type) =>
      machine.collectionValue(
        named(family, family === "Map" ? box(anyType) : type, ...(family === "Map" ? [intType] : [])),
        family === "Map"
          ? items.map((key) => [key, machine.state.cells[machine.object(key).fields.number].value])
          : items,
      );
    const a = make(left, box(intType)),
      b = make(right, box(anyType));
    assert.equal(
      compare(machine, a, b, named(family, box(anyType), ...(family === "Map" ? [intType] : []))),
      true,
      family,
    );
  }
});

test("cyclic exact comparison terminates without requiring matching sharing layouts", () => {
  const machine = new VM(program());
  const make = (type, count) => {
    const nodes = Array.from({ length: count }, () =>
      record(machine, type, { number: integer(3), next: { kind: "null", value: null } }),
    );
    nodes.forEach(
      (node, index) => (machine.state.cells[machine.object(node).fields.next].value = nodes[(index + 1) % count]),
    );
    return nodes[0];
  };
  const view = named("example.Node", anyType);
  assert.equal(compare(machine, make(named("example.Node", intType), 1), make(view, 3), view), true);
});

test("primitive exactness and null flattening remain independent of broad views", () => {
  const machine = new VM(program());
  assert.equal(compare(machine, integer(3), { kind: "float", value: 3 }, anyType), false);
  assert.equal(compare(machine, { kind: "char", value: "a" }, { kind: "string", value: "a" }, anyType), false);
  assert.equal(compare(machine, integer(3), integer(3), optional(intType), intType), true);
  assert.equal(
    compare(
      machine,
      { kind: "null", value: null },
      { kind: "null", value: null },
      optional(intType),
      optional(anyType),
    ),
    true,
  );
});

test("v3 requires complete comparison views and rejects an old untyped exact opcode", () => {
  for (const fields of [
    {},
    { left_type: intType, right_type: intType },
    { left_type: intType, right_type: intType, negate: 0 },
  ]) {
    const data = program();
    data.functions[data.entry].code.unshift({ op: "exact_compare", ...fields, span });
    assert.throws(() => new VM(data), /invalid exact comparison views/);
  }
  const data = program();
  data.functions[data.entry].code.unshift({ op: "binary", operator: "===", span });
  assert.throws(() => new VM(data), /exact equality requires declared comparison views/);
  const previous = program();
  previous.profile = "bifoil-vm.v2";
  previous.functions[previous.entry].code.unshift({
    op: "exact_compare",
    left_type: intType,
    right_type: intType,
    negate: false,
    span,
  });
  assert.throws(() => new VM(previous), /exact comparison views require bifoil-vm.v3/);
});

test("eager and lazy package chunks must retain their root's exact instruction profile", async () => {
  for (const lazy of [false, true]) {
    for (const [root, chunk] of [
      ["bifoil-vm.v3", "bifoil-vm.v2"],
      ["bifoil-vm.v2", "bifoil-vm.v3"],
    ]) {
      const input = program();
      input.profile = chunk;
      const data = splitCompiledProgram(input, { lazy });
      data.manifest.profile = root;
      const load = () => loadPackage(data.manifest, (name) => data.sources.get(name));
      if (lazy) {
        const machine = new VM(await load());
        await assert.rejects(machine.runAsync(), /different instruction profile/);
      } else await assert.rejects(load(), /different instruction profile/);
    }
  }
});

test("deep declared-view comparison traverses fields without consuming the host call stack", () => {
  const machine = new VM(program());
  const make = (type) => {
    let next = { kind: "null", value: null };
    for (let index = 0; index < 6000; index++) next = record(machine, type, { number: integer(index), next });
    return next;
  };
  const view = named("example.Node", anyType);
  const first = make(named("example.Node", intType)),
    second = make(view);
  assert.equal(compare(machine, first, second, view), true);
  machine.state.cells[machine.object(second).fields.number].value = integer(-1);
  assert.equal(compare(machine, first, second, view), false);
});

test("sealed-parent views preserve active variant discrimination and payload field views", () => {
  const data = program();
  data.types["example.Outcome"] = { ...definition({}, generic), kind: "sealed", variants: ["Success", "Pending"] };
  data.types["example.Outcome.Success"] = {
    ...definition({ number: field(intType) }, generic),
    kind: "variant",
    parent: named("example.Outcome", parameter),
  };
  data.types["example.Outcome.Pending"] = {
    ...definition({}, generic),
    kind: "variant",
    parent: named("example.Outcome", parameter),
  };
  const machine = new VM(data),
    view = named("example.Outcome", anyType);
  const first = record(machine, named("example.Outcome.Success", intType), { number: integer(3) });
  const second = record(machine, named("example.Outcome.Success", anyType), { number: integer(3) });
  const pending = record(machine, named("example.Outcome.Pending", anyType), {});
  machine.object(first).tag = machine.object(second).tag = "Success";
  machine.object(pending).tag = "Pending";
  assert.equal(compare(machine, first, second, view), true);
  assert.equal(compare(machine, first, pending, view), false);
  assert.deepEqual(machine.valueType(first), named("example.Outcome.Success", intType));
});

test("a restored comparison reifies its views after its caller code was evicted", async () => {
  const input = program();
  input.functions[input.entry].code = [
    { op: "constant", ty: intType, value: 3, span },
    { op: "construct", ty: box(intType), fields: ["number"], tag: null, span },
    { op: "load", name: "dependency.ask", span },
    { op: "call", names: [], direct: true, span },
    { op: "exact_compare", left_type: box(anyType), right_type: box(anyType), negate: false, span },
    { op: "format", count: 1, span },
    { op: "print", span },
    { op: "constant", ty: { kind: "unit" }, value: null, span },
    { op: "return", span },
  ];
  input.functions["dependency.ask"] = {
    signature: { id: "dependency.ask", params: [], result: box(anyType), suspend: true, scene: false },
    init: false,
    local: false,
    code: [
      { op: "begin_choice", span },
      { op: "constant", ty: { kind: "boolean" }, value: true, span },
      { op: "constant", ty: { kind: "string" }, value: "Compare", span },
      { op: "offer", target: 5, span },
      { op: "choose", fallback: null, span },
      { op: "constant", ty: intType, value: 3, span },
      { op: "construct", ty: box(anyType), fields: ["number"], tag: null, span },
      { op: "return", span },
    ],
  };
  const data = splitCompiledProgram(input, { lazy: true });
  const originalProgram = await loadPackage(data.manifest, (name) => data.sources.get(name), { maxResidentModules: 1 });
  const original = new VM(originalProgram);
  assert.equal((await original.runAsync()).status, "waiting");
  assert.ok(packageCodeStats(originalProgram).evictions >= 1);
  const checkpoint = original.save();
  const reads = [];
  const freshProgram = await loadPackage(
    data.manifest,
    (name) => {
      reads.push(name);
      return data.sources.get(name);
    },
    { maxResidentModules: 1 },
  );
  const restored = VM.restore(freshProgram, checkpoint);
  assert.deepEqual(reads, [], "restoration validates headers without loading or replaying bodies");
  let result = restored.choose(0);
  while (result.status === "loading") {
    await result.ready;
    result = restored.run();
  }
  assert.equal(result.status, "done");
  assert.deepEqual(restored.state.transcript, ["true"]);
  assert.equal(reads.length, 2, "the active helper and then its evicted caller must be fetched");
  assert.ok(packageCodeStats(freshProgram).evictions >= 1);
});
