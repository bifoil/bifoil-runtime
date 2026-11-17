import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM, BifoilError } from "../src/vm.mjs";
import { loadCompiledProgram, loadPackage, validateCodeChunk } from "../src/packages.mjs";
import { installChoiceScript } from "../src/choicescript.mjs";
import { splitCompiledProgram } from "./support/packages.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL("./fixtures/" + name + ".json", import.meta.url), "utf8"));
const incompatibleProgram = (error) =>
  error instanceof BifoilError && /unsupported program format\/profile/.test(error.message);

function savedProgram(name) {
  const program = fixture(name);
  const machine = new VM(program);
  assert.equal(machine.run().status, "waiting");
  return { program, machine, checkpoint: machine.save() };
}

test("matching original and current program versions preserve restored execution", () => {
  for (const name of ["checkpoint", "browser"]) {
    const { program, machine, checkpoint } = savedProgram(name);
    const restored = VM.restore(program, checkpoint);
    const wait = machine.run();
    assert.deepEqual(restored.run(), wait);
    const selected = wait.options.findIndex((option) => option.enabled);
    assert.ok(selected >= 0);
    assert.deepEqual(restored.choose(selected), machine.choose(selected));
  }
});

test("program formats cannot select a different instruction profile", () => {
  for (const [format, profile] of [
    ["bifoil.program.v1", "bifoil-vm.v2"],
    ["bifoil.program.v2", "bifoil-vm.v1"],
    ["bifoil.program.v3", "bifoil-vm.v2"],
    ["bifoil.program.v2", "bifoil-vm.v4"],
    [undefined, "bifoil-vm.v2"],
    ["bifoil.program.v2", undefined],
  ]) {
    assert.throws(() => new VM({ ...fixture("checkpoint"), format, profile }), incompatibleProgram);
  }
});

test("inline scene loading checks compatibility without asking for code", async () => {
  let reads = 0;
  const program = { ...fixture("checkpoint"), profile: "bifoil-vm.v2" };
  await assert.rejects(
    loadCompiledProgram("*bifoil " + JSON.stringify(program), () => {
      reads++;
      throw new Error("incompatible inline input must not read code");
    }),
    incompatibleProgram,
  );
  assert.equal(reads, 0);
});

test("current checkpoint writers retain the original program execution profile", () => {
  const { program, machine, checkpoint } = savedProgram("checkpoint");
  const saved = JSON.parse(checkpoint);
  assert.equal(program.format, "bifoil.program.v1");
  assert.equal(saved.format, "bifoil.checkpoint.v2");
  assert.equal(saved.profile, "bifoil-vm.v1");
  assert.deepEqual(VM.restore(program, checkpoint).choose(0), machine.choose(0));
});

test("original checkpoint envelopes remain readable for original programs", () => {
  const { program, machine, checkpoint } = savedProgram("checkpoint");
  const original = JSON.parse(checkpoint);
  original.format = "bifoil.checkpoint.v1";
  delete original.objects;
  delete original.history;
  delete original.prose;
  assert.deepEqual(VM.restore(program, JSON.stringify(original)).choose(0), machine.choose(0));
});

test("incompatible checkpoints fail before restore callbacks", () => {
  const { program, checkpoint } = savedProgram("browser");
  let restored = 0;
  for (const mutate of [
    (state) => (state.format = "bifoil.checkpoint.v1"),
    (state) => (state.format = "bifoil.checkpoint.v3"),
    (state) => (state.profile = "bifoil-vm.v1"),
    (state) => (state.profile = "unknown"),
    (state) => (state.build = "0".repeat(64)),
  ]) {
    const state = JSON.parse(checkpoint);
    mutate(state);
    assert.throws(
      () => VM.restore(program, JSON.stringify(state), { beforeRestore: () => restored++ }),
      /different build or profile/,
    );
  }
  assert.equal(restored, 0);
  VM.restore(program, checkpoint, { beforeRestore: () => restored++ });
  assert.equal(restored, 1);
});

test("both package layouts reject other profiles before fetching code", async () => {
  for (const lazy of [false, true]) {
    for (const profile of ["bifoil-vm.v1", "bifoil-vm.v4", undefined]) {
      const data = splitCompiledProgram(fixture("browser"), { lazy });
      data.manifest.profile = profile;
      let reads = 0;
      await assert.rejects(
        loadPackage(data.manifest, () => {
          reads++;
          throw new Error("incompatible package must not read code");
        }),
        /invalid compiled package manifest/,
      );
      assert.equal(reads, 0);
    }
  }
});

test("code chunks require the supported code container and current profile", () => {
  const chunk = { format: "bifoil.code.v1", profile: "bifoil-vm.v2", module: "main", functions: {} };
  assert.equal(validateCodeChunk(chunk), chunk);
  for (const change of [{ format: "bifoil.code.v2" }, { profile: "bifoil-vm.v1" }, { profile: "bifoil-vm.v4" }]) {
    assert.throws(() => validateCodeChunk({ ...chunk, ...change }), /unsupported compiled code chunk/);
  }
});

test("an incompatible attachment cannot create a host or replace a live session", () => {
  class Scene {
    constructor() {
      this.stats = {};
    }
  }
  Scene.validCommands = {};
  let factories = 0,
    cancellations = 0;
  const adapter = installChoiceScript(Scene, {
    legacy() {
      factories++;
      return { cancel: () => cancellations++ };
    },
  });
  const scene = new Scene();
  const first = adapter.attach(scene, fixture("checkpoint"));
  for (const profile of ["bifoil-vm.v2", "unknown"]) {
    assert.throws(() => adapter.attach(scene, { ...fixture("checkpoint"), profile }), incompatibleProgram);
    assert.equal(scene.bifoilSession, first);
    assert.equal(factories, 1);
    assert.equal(cancellations, 0);
  }
  adapter.attach(scene, fixture("checkpoint"));
  assert.equal(factories, 2);
  assert.equal(cancellations, 1);
});

test("an incompatible package command preserves the previous prepared choice", () => {
  for (const lazy of [false, true]) {
    class Scene {
      constructor() {
        this.stats = {};
      }
    }
    Scene.validCommands = {};
    let choose,
      cancellations = 0;
    const adapter = installChoiceScript(Scene, {
      print() {},
      renderChoice: (scene, options, callback) => (choose = callback),
      legacy: () => ({ cancel: () => cancellations++ }),
    });
    const scene = new Scene();
    const previous = adapter.attach(scene, fixture("checkpoint"));
    previous.run();
    const checkpoint = scene.stats.bifoil_checkpoint;
    const data = splitCompiledProgram(fixture("browser"), { lazy });
    data.manifest.profile = "bifoil-vm.v1";
    assert.throws(() => scene.bifoil(JSON.stringify(data.manifest)), /invalid compiled package manifest/);
    assert.equal(scene.bifoilSession, previous);
    assert.equal(scene.stats.bifoil_checkpoint, checkpoint);
    assert.equal(cancellations, 0);
    assert.equal(choose(0).status, "done");
  }
});
