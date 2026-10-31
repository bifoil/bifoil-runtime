import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM, binary, BifoilError } from "../src/vm.mjs";
import { installChoiceScript } from "../src/choicescript.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL("./fixtures/" + name + ".json", import.meta.url), "utf8"));
const primitive = (kind, value) => ({ kind, value });
const integer = (n) => primitive("int", n);

test("compiled checkpoint preserves partial expressions, shared captured cells, and label snapshots", () => {
  const program = fixture("checkpoint");
  const machine = new VM(program);
  const wait = machine.run();
  assert.deepEqual(wait.options, [{ label: "Take 2 and ${literal}", enabled: true }]);
  assert.equal(wait.status, "waiting");
  assert.equal(machine.state.frames.length, 2);
  assert.deepEqual(machine.state.frames[0].stack, [integer(2)]);
  const checkpoint = machine.save();
  const restored = VM.restore(program, checkpoint);
  assert.deepEqual(restored.run(), { status: "waiting", output: [], options: wait.options });
  const result = restored.choose(0);
  assert.equal(result.status, "done");
  assert.deepEqual(result.output, ["Result 12; counter 2; next 3; after 3."]);
  assert.deepEqual(machine.choose(0), result);
  assert.throws(() => restored.save(), /input checkpoint/);
});
test("malformed parameter interfaces fail before execution state is created", () => {
  for (const mutate of [
    (parameters) => {
      parameters[0].name = "";
    },
    (parameters) => {
      parameters[1].name = parameters[0].name;
    },
    (parameters) => {
      parameters[0].vararg = true;
    },
    (parameters) => {
      parameters[1].vararg = true;
    },
    (parameters) => {
      parameters[1].vararg = "yes";
    },
    (parameters) => {
      parameters[0] = null;
    },
  ]) {
    const program = fixture("checkpoint");
    mutate(program.functions["helpers.add"].signature.params);
    assert.throws(
      () => new VM(program),
      (error) => error instanceof BifoilError && /invalid parameters|duplicate parameters/.test(error.message),
    );
  }
});

test("supplied arguments precede omitted defaults, and defaults execute in declaration order", () => {
  const result = new VM(fixture("ordering")).run();
  assert.deepEqual(result.output, ["3 sd1d2"]);
  assert.equal(result.status, "done");
});
test("an escaping closure keeps its returned parent environment alive across restoration", () => {
  const program = fixture("escaping");
  const machine = new VM(program);
  assert.equal(machine.run().options[0].label, "Continue from 1");
  const restored = VM.restore(program, machine.save());
  assert.deepEqual(restored.choose(0).output, ["2 then 3."]);
});
test("numeric operations retain exact types, truncate division, and check errors", () => {
  assert.deepEqual(binary("/", integer(-3), integer(2)), integer(-1));
  assert.deepEqual(binary("%", integer(-5), integer(3)), integer(-2));
  assert.equal(binary("%", integer(-2147483648), integer(-1)).value, 0);
  assert.equal(binary("==", integer(3), primitive("float", 3)).value, true);
  assert.equal(binary("===", integer(3), primitive("float", 3)).value, false);
  assert.throws(() => binary("+", integer(2147483647), integer(1)), /overflow/);
  assert.throws(() => binary("/", integer(-2147483648), integer(-1)), /overflow/);
  assert.throws(() => binary("/", integer(1), integer(0)), /zero/);
  assert.throws(() => binary("*", primitive("float", Number.MAX_VALUE), primitive("float", 2)), /non-finite/);
});
test("fairmath preserves the pinned engine endpoint and sign rules", () => {
  for (const [base, op, change, result] of [
    [0, "%+", 0, 1],
    [100, "%+", 0, 100],
    [100, "%+", 1, 99],
    [0, "%-", 1, 1],
    [50, "%+", -20, 40],
    [50, "%-", -20, 60],
    [50, "%+", 500, 99],
    [50, "%-", 500, 1],
    [1.2, "%+", 0, 2],
  ])
    assert.equal(binary(op, primitive("float", base), primitive("float", change)).value, result);
  assert.throws(() => binary("%+", integer(101), integer(1)), /0..100/);
});
test("string ordering compares Unicode scalars", () => {
  assert.equal(binary(">", primitive("string", "😀"), primitive("string", "\ue000")).value, true);
});
test("same-build checkpoint validation rejects mismatches and invalid references", () => {
  const program = fixture("checkpoint");
  const machine = new VM(program);
  machine.run();
  const saved = machine.save();
  assert.throws(() => VM.restore({ ...program, build: "a".repeat(64) }, saved), /different build/);
  const corrupt = JSON.parse(saved);
  corrupt.frames[0].env = 999999;
  assert.throws(() => VM.restore(program, JSON.stringify(corrupt)), /invalid checkpoint frame/);
  assert.throws(() => VM.restore(program, "{}"), /different build/);
  assert.throws(() => VM.restore(program, "{"), /JSON/);
});
test("signed floating zero survives checkpoint serialization", () => {
  const program = fixture("checkpoint");
  const machine = new VM(program);
  machine.run();
  const id = machine.state.cells.push({ ty: { kind: "float" }, mutable: false, value: primitive("float", -0) }) - 1;
  machine.state.envs[0].bindings.signedZero = id;
  const restored = VM.restore(program, machine.save());
  assert.ok(Object.is(restored.cell(0, "signedZero").value.value, -0));
});
test("runtime errors retain original Bifoil source locations", () => {
  const program = fixture("overflow");
  assert.throws(
    () => new VM(program).run(),
    (error) => error instanceof BifoilError && /src\/main.bfl:3: Int overflow/.test(error.message),
  );
});
test("ChoiceScript adapter persists plain save data and rejects stale callbacks", () => {
  class Scene {
    constructor() {
      this.stats = {};
      this.finished = false;
    }
  }
  Scene.validCommands = {};
  const callbacks = [];
  const output = [];
  const adapter = installChoiceScript(Scene, {
    print(scene, text) {
      output.push(text);
    },
    renderChoice(scene, options, select) {
      assert.equal(options[0].label, "Take 2 and ${literal}");
      callbacks.push(select);
    },
  });
  const scene = new Scene();
  scene.bifoil(JSON.stringify(fixture("checkpoint")));
  assert.equal(typeof scene.stats.bifoil_checkpoint, "string");
  assert.ok(scene.finished);
  const restored = new Scene();
  restored.stats.bifoil_checkpoint = scene.stats.bifoil_checkpoint;
  adapter.restore(restored, fixture("checkpoint"));
  assert.throws(() => callbacks[1](999), /invalid choice/);
  callbacks[1](0);
  assert.deepEqual(output, ["Result 12; counter 2; next 3; after 3."]);
  assert.equal(restored.stats.bifoil_checkpoint, undefined);
  assert.throws(() => callbacks[1](0), /stale/);
});
test("unsupported instruction profiles fail explicitly", () => {
  assert.throws(() => new VM({ ...fixture("checkpoint"), profile: "other" }), /profile/);
});

test("bounded execution slices preserve operands and allow saves only at prepared input", () => {
  const input = fixture("checkpoint"),
    output = [];
  let machine = new VM(input, null, { quantum: 1 }),
    result = machine.run(),
    slices = 0;
  while (result.status === "running") {
    slices++;
    output.push(...result.output);
    assert.throws(() => machine.save(), /prepared input/);
    result = machine.run();
  }
  assert.ok(slices > 5);
  assert.deepEqual(result.options, [{ label: "Take 2 and ${literal}", enabled: true }]);
  machine = VM.restore(input, machine.save(), { quantum: 1 });
  result = machine.choose(0);
  while (result.status === "running") {
    output.push(...result.output);
    result = machine.run();
  }
  output.push(...result.output);
  assert.equal(result.status, "done");
  assert.deepEqual(output, ["Result 12; counter 2; next 3; after 3."]);
});

test("the adapter schedules bounded work and ignores obsolete continuation callbacks", () => {
  class Scene {
    constructor() {
      this.stats = {};
    }
  }
  Scene.validCommands = {};
  const scheduled = [],
    output = [],
    choices = [];
  let finished = 0;
  installChoiceScript(Scene, {
    quantum: 1,
    schedule: (continueExecution) => scheduled.push(continueExecution),
    print: (scene, text) => output.push(text),
    renderChoice: (scene, options, select) => choices.push(select),
    finish: () => finished++,
  });
  const scene = new Scene();
  scene.bifoil(JSON.stringify(fixture("checkpoint")));
  assert.equal(scheduled.length, 1);
  scene.bifoilSession.run();
  const before = JSON.stringify(scene.bifoilSession.machine.state);
  scheduled.shift()();
  assert.equal(JSON.stringify(scene.bifoilSession.machine.state), before);
  while (scheduled.length) scheduled.shift()();
  assert.equal(choices.length, 1);
  assert.equal(typeof scene.stats.bifoil_checkpoint, "string");
  choices[0](0);
  while (scheduled.length) scheduled.shift()();
  assert.equal(finished, 1);
  assert.equal(scene.stats.bifoil_checkpoint, undefined);
  assert.deepEqual(output, ["Result 12; counter 2; next 3; after 3."]);
  assert.throws(() => choices[0](0), /stale/);
});

test("a checked failure permanently stops execution and cannot become a restorable checkpoint", () => {
  const machine = new VM(fixture("overflow"));
  let original;
  assert.throws(
    () => machine.run(),
    (error) => {
      original = error;
      return /Int overflow/.test(error.message);
    },
  );
  for (const operation of [
    () => machine.run(),
    () => machine.save(),
    () => machine.choose(0),
    () => machine.submit("x"),
  ])
    assert.throws(operation, (error) => error === original);
  assert.equal(machine.state.failed, true);
  assert.equal(machine.state.pending, null);
  const waiting = new VM(fixture("checkpoint"));
  waiting.run();
  const corrupt = JSON.parse(waiting.save());
  corrupt.failed = true;
  assert.throws(() => VM.restore(fixture("checkpoint"), JSON.stringify(corrupt)), /stopped story/);
});
