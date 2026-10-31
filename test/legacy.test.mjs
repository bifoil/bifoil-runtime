import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { installChoiceScript } from "../src/choicescript.mjs";
import { fromLegacy, toLegacy } from "../src/legacy/values.mjs";
import { readLegacy } from "../src/legacy.mjs";
import { encodeState, decodeState } from "../src/legacy/state.mjs";

const program = JSON.parse(readFileSync(new URL("./fixtures/legacy.json", import.meta.url), "utf8"));
function host() {
  const state = { calls: 0, answer: 0 };
  const invocations = { starts: 0, resumes: 0, restores: 0 };
  return {
    state,
    invocations,
    read(name) {
      return state[name.toLowerCase()];
    },
    write(name, value) {
      state[name.toLowerCase()] = value;
    },
    start() {
      invocations.starts++;
      state.calls++;
      return {
        status: "waiting",
        options: [{ label: "Take " + state.calls, enabled: true }],
        continuation: { callsAtWait: state.calls },
      };
    },
    resume(request, saved, index) {
      invocations.resumes++;
      assert.equal(index, 0);
      assert.equal(state.calls, saved.callsAtWait);
      state.answer = 5;
      return { status: "returned", value: state.answer };
    },
    snapshot() {
      return { ...state };
    },
    restore(saved) {
      invocations.restores++;
      Object.assign(state, saved);
    },
  };
}

test("legacy input snapshots preserve computed operands and external state without replay", () => {
  const original = host(),
    machine = new VM(program, null, { legacy: original });
  const waiting = machine.run();
  assert.deepEqual(waiting.options, [{ label: "Take 2", enabled: true }]);
  assert.equal(machine.state.frames[0].stack[0].value, 1);
  const fresh = host(),
    restored = VM.restore(program, machine.save(), { legacy: fresh });
  assert.equal(fresh.state.calls, 2);
  assert.equal(fresh.invocations.starts, 0);
  assert.deepEqual(restored.choose(0).options, [{ label: "Finish 3", enabled: true }]);
  const another = host(),
    final = VM.restore(program, restored.save(), { legacy: another });
  assert.equal(another.state.calls, 3);
  assert.deepEqual(final.choose(0).output, ["9|3"]);
  assert.equal(another.invocations.starts, 0);
  assert.equal(another.invocations.resumes, 0);
});

test("legacy primitive conversions reject untrusted shapes, ranges and malformed text", () => {
  assert.throws(() => fromLegacy("3", { kind: "int" }), /not an Int/);
  assert.throws(() => fromLegacy(3.5, { kind: "int" }), /overflow/);
  assert.throws(() => fromLegacy(2147483648, { kind: "int" }), /overflow/);
  assert.throws(() => fromLegacy(Infinity, { kind: "float" }), /non-finite/);
  assert.throws(() => fromLegacy("true", { kind: "boolean" }), /Boolean/);
  assert.throws(() => fromLegacy(String.fromCharCode(0xd800), { kind: "string" }), /scalar/);
  assert.throws(() => fromLegacy("ab", { kind: "char" }), /one Char/);
  assert.deepEqual(fromLegacy("😀", { kind: "char" }), { kind: "char", value: "😀" });
  assert.deepEqual(fromLegacy(null, { kind: "nullable", inner: { kind: "int" } }), { kind: "null", value: null });
  assert.equal(toLegacy({ kind: "float", value: 3 }, { kind: "float" }), 3);
  assert.throws(() => toLegacy({ kind: "string", value: "3" }, { kind: "int" }), /mismatch/);
});

test("native continuation graphs preserve aliases, cycles and special numbers", () => {
  const shared = { negativeZero: -0, infinite: Infinity, invalid: NaN, absent: undefined };
  const root = { first: shared, second: shared };
  root.self = root;
  const restored = decodeState(JSON.parse(JSON.stringify(encodeState(root))));
  assert.strictEqual(restored.first, restored.second);
  assert.strictEqual(restored.self, restored);
  assert.ok(Object.is(restored.first.negativeZero, -0));
  assert.equal(restored.first.infinite, Infinity);
  assert.ok(Number.isNaN(restored.first.invalid));
  assert.ok(Object.hasOwn(restored.first, "absent"));
  assert.throws(() => encodeState({ callback() {} }), /host function/);
  assert.throws(() => decodeState({ format: "bifoil.legacy-state.v1", root: ["ref", 3], nodes: [] }), /reference/);
});

test("invalid VM checkpoints are rejected before restoring a legacy host", () => {
  const machine = new VM(program, null, { legacy: host() });
  machine.run();
  const corrupt = JSON.parse(machine.save());
  corrupt.frames[0].env = 999999;
  const external = host();
  assert.throws(() => VM.restore(program, JSON.stringify(corrupt), { legacy: external }), /checkpoint frame/);
  assert.equal(external.invocations.restores, 0);
});

test("input presentation retains feedback and rejects consumed submission callbacks", () => {
  const external = host();
  const waiting = (feedback) => ({
    status: "waiting",
    options: [],
    continuation: { ready: true },
    input: {
      kind: "number",
      minimum: "1",
      maximum: "9",
      integer: true,
      allow_blank: false,
      ...(feedback ? { feedback } : {}),
    },
  });
  external.start = () => {
    external.state.calls++;
    return waiting();
  };
  external.resume = (request, saved, response) =>
    response === "7" ? { status: "returned", value: 5 } : waiting("Use seven.");
  class Scene {
    constructor() {
      this.stats = {};
    }
  }
  Scene.validCommands = {};
  const submissions = [],
    choices = [],
    output = [];
  installChoiceScript(Scene, {
    legacy: () => external,
    renderInput: (scene, input, submit) => submissions.push({ input, submit }),
    renderChoice: (scene, options, select) => choices.push(select),
    print: (scene, text) => output.push(text),
  });
  const scene = new Scene();
  scene.bifoil(JSON.stringify(program));
  assert.equal(submissions[0].input.kind, "number");
  submissions[0].submit("x");
  assert.equal(submissions[1].input.feedback, "Use seven.");
  assert.throws(() => submissions[0].submit("7"), /stale/);
  submissions[1].submit("7");
  assert.equal(choices.length, 1);
  choices[0](0);
  assert.deepEqual(output, ["9|3"]);
  assert.throws(() => submissions[1].submit("7"), /stale/);
});

test("a failed legacy result cannot repeat external effects through another selection or save", () => {
  const external = host();
  let resumed = 0,
    cancelled = 0;
  external.resume = () => {
    resumed++;
    return { status: "returned", value: "untrusted" };
  };
  external.cancel = () => cancelled++;
  const machine = new VM(program, null, { legacy: external });
  machine.run();
  let original;
  assert.throws(
    () => machine.choose(0),
    (error) => {
      original = error;
      return /not an Int/.test(error.message);
    },
  );
  assert.throws(
    () => machine.choose(0),
    (error) => error === original,
  );
  assert.throws(
    () => machine.save(),
    (error) => error === original,
  );
  assert.throws(
    () => machine.run(),
    (error) => error === original,
  );
  assert.equal(resumed, 1);
  assert.equal(cancelled, 1);
});

test("large variadic groups and output batches avoid JavaScript argument-count limits", () => {
  const input = structuredClone(program),
    fn = input.functions["main.ask"],
    count = 300000;
  fn.signature.params = [{ name: "values", ty: { kind: "int" }, mutable: false, default: false, vararg: true }];
  fn.code.unshift({ op: "load", name: "values", span: fn.code[0].span });
  fn.code[1].arguments = 1;
  const external = {
    start(request) {
      assert.equal(request.args.length, count);
      assert.equal(request.args[count - 1], count - 1);
      return { status: "returned", value: count, output: Array(count).fill("line") };
    },
  };
  const machine = new VM(input, null, { legacy: external });
  machine.state.boot = [];
  const list = machine.collectionValue(
    { kind: "named", name: "List", args: [{ kind: "int" }] },
    Array.from({ length: count }, (_, value) => ({ kind: "int", value })),
  );
  machine.pushCall({ kind: "function", id: "main.ask", env: 0 }, [list], [null], { direct: true, spreads: [true] });
  const result = machine.run();
  assert.equal(result.status, "done");
  assert.equal(result.output.length, count);
  assert.equal(machine.state.transcript.length, count);
});

test("the adapter publishes completed output before reporting a terminal bridge failure", () => {
  class Scene {
    constructor() {
      this.stats = {};
    }
  }
  Scene.validCommands = {};
  const output = [],
    external = host();
  external.start = () => ({ status: "returned", value: "wrong", output: ["Before failure."] });
  installChoiceScript(Scene, { legacy: () => external, print: (scene, text) => output.push(text) });
  const scene = new Scene();
  assert.throws(() => scene.bifoil(JSON.stringify(program)), /not an Int/);
  assert.deepEqual(output, ["Before failure."]);
  assert.throws(() => scene.bifoilSession.run(), /not an Int/);
  assert.deepEqual(output, ["Before failure."]);
});

test("checkpoints retain provided legacy state before the first boundary read or call", () => {
  const base = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  for (const kind of ["global", "call"]) {
    const deferred = structuredClone(base);
    if (kind === "global") {
      deferred.legacy_globals = { future: { ty: { kind: "int" }, mutable: false, target: "future" } };
    } else {
      deferred.functions["main.unusedBridge"] = {
        signature: {
          id: "main.unusedBridge",
          params: [],
          result: { kind: "unit" },
          suspend: false,
          scene: false,
        },
        init: false,
        code: [
          {
            op: "legacy_call",
            arguments: 0,
            target: { scene: "unused", label: null, result: null },
            span: { file: "src/main.bfl", line: 1 },
          },
          { op: "return", span: { file: "src/main.bfl", line: 1 } },
        ],
      };
    }
    const original = host();
    original.state.future = 37;
    let reads = 0;
    const read = original.read;
    original.read = (name) => {
      reads++;
      return read(name);
    };
    const machine = new VM(deferred, null, { legacy: original });
    assert.equal(machine.run().status, "waiting");
    assert.equal(machine.state.legacyUsed, undefined);
    const checkpoint = machine.save();
    assert.equal(reads, 0);
    assert.equal(original.invocations.starts, 0);
    const fresh = host();
    fresh.state.future = 999;
    const restored = VM.restore(deferred, checkpoint, { legacy: fresh });
    assert.equal(fresh.state.future, 37);
    assert.equal(fresh.invocations.restores, 1);
    assert.equal(fresh.invocations.starts, 0);
    if (kind === "global") assert.deepEqual(readLegacy(restored, "future"), { kind: "int", value: 37 });
  }
});
