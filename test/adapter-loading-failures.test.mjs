import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installChoiceScript } from "../src/choicescript.mjs";
import { loadPackage } from "../src/packages.mjs";
import { nativeEngineHost } from "../src/legacy/node-host.mjs";
import { splitCompiledProgram } from "./support/packages.mjs";

const span = { file: "src/loading.bfl", line: 1 };
function story(message = "Original.") {
  const program = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  const entry = program.functions[program.entry];
  entry.code = [
    { op: "constant", ty: { kind: "string" }, value: message, span },
    { op: "print", span },
    { op: "constant", ty: { kind: "unit" }, value: null, span },
    { op: "return", span },
  ];
  program.functions = { [program.entry]: entry };
  return program;
}
function sceneType() {
  class Scene {
    constructor() {
      this.stats = {};
      this.name = "startup";
    }
  }
  Scene.validCommands = {};
  return Scene;
}
function delayedCode() {
  const data = splitCompiledProgram(story(), { lazy: true });
  const requested = Promise.withResolvers(),
    response = Promise.withResolvers();
  const readChunk = (name) => {
    requested.resolve(name);
    return response.promise;
  };
  return { data, requested, response, readChunk };
}

test("polling a loading session preserves the latest ready handle and publishes completion once", async () => {
  const pending = delayedCode(),
    Scene = sceneType(),
    output = [];
  let finishes = 0;
  const adapter = installChoiceScript(Scene, { print: (_scene, text) => output.push(text), finish: () => finishes++ });
  const program = await loadPackage(pending.data.manifest, pending.readChunk);
  const scene = new Scene(),
    session = adapter.attach(scene, program);
  const first = session.run(),
    latest = session.run();
  const name = await pending.requested.promise;
  assert.notEqual(first.ready, latest.ready);
  assert.equal(scene.bifoilLoading, latest.ready);
  pending.response.resolve(pending.data.sources.get(name));
  assert.equal(await first.ready, null);
  assert.equal((await latest.ready).status, "done");
  assert.deepEqual(output, ["Original."]);
  assert.equal(finishes, 1);
  assert.equal(scene.bifoilLoading, undefined);
});

test("initial package load failure is reported once across nested loader promises", async () => {
  const pending = delayedCode(),
    Scene = sceneType(),
    errors = [];
  installChoiceScript(Scene, {
    readChunk: pending.readChunk,
    error: (_scene, error) => errors.push(error),
    print() {},
  });
  const scene = new Scene();
  scene.bifoil(JSON.stringify(pending.data.manifest));
  const outer = scene.bifoilLoading;
  await pending.requested.promise;
  const rejected = assert.rejects(outer, /Original read failure/);
  pending.response.reject(new Error("Original read failure"));
  await rejected;
  assert.equal(errors.length, 1);
  assert.equal(scene.bifoilFailure, errors[0]);
  assert.equal(scene.bifoilLoading, undefined);
});

test("a failed polled load clears only its current handle and deduplicates its diagnostic", async () => {
  const pending = delayedCode(),
    Scene = sceneType(),
    errors = [];
  const adapter = installChoiceScript(Scene, { error: (_scene, error) => errors.push(error), print() {} });
  const scene = new Scene(),
    session = adapter.attach(scene, await loadPackage(pending.data.manifest, pending.readChunk));
  const first = session.run(),
    latest = session.run();
  await pending.requested.promise;
  const failures = [
    assert.rejects(first.ready, /Original read failure/),
    assert.rejects(latest.ready, /Original read failure/),
  ];
  pending.response.reject(new Error("Original read failure"));
  await Promise.all(failures);
  assert.equal(errors.length, 1);
  assert.equal(scene.bifoilLoading, undefined);
});

test("late package failures cannot replace or report errors into a newer session", async () => {
  const pending = delayedCode(),
    Scene = sceneType(),
    output = [],
    errors = [];
  const adapter = installChoiceScript(Scene, {
    readChunk: pending.readChunk,
    print: (_scene, text) => output.push(text),
    error: (_scene, error) => errors.push(error),
  });
  const scene = new Scene();
  scene.bifoil(JSON.stringify(pending.data.manifest));
  const outer = scene.bifoilLoading;
  await pending.requested.promise;
  const replacement = adapter.attach(scene, story("Replacement."));
  assert.equal(replacement.run().status, "done");
  const rejected = assert.rejects(outer, /Retired read failure/);
  pending.response.reject(new Error("Retired read failure"));
  await rejected;
  assert.equal(scene.bifoilSession, replacement);
  assert.equal(scene.bifoilFailure, undefined);
  assert.equal(scene.bifoilLoading, undefined);
  assert.deepEqual(output, ["Replacement."]);
  assert.deepEqual(errors, []);
});

test("detachment inside native execution stops presentation before the result is pumped", () => {
  const Scene = sceneType(),
    output = [];
  let finishes = 0;
  const adapter = installChoiceScript(Scene, {
    legacy(scene) {
      return {
        start() {
          adapter.detach(scene);
          return { status: "returned" };
        },
      };
    },
    print: (_scene, text) => output.push(text),
    finish: () => finishes++,
  });
  const program = story();
  program.functions[program.entry].code.unshift(
    { op: "legacy_call", arguments: 0, target: { scene: "native", label: null, result: null }, span },
    { op: "pop", span },
  );
  const scene = new Scene(),
    session = adapter.attach(scene, program);
  assert.equal(session.run().status, "done");
  assert.equal(scene.bifoilSession, undefined);
  assert.deepEqual(output, []);
  assert.equal(finishes, 0);
});

test(
  "the default timer resumes yielded execution and finishes without a custom scheduler",
  { timeout: 10000 },
  async () => {
    const Scene = sceneType(),
      output = [],
      finished = Promise.withResolvers();
    const adapter = installChoiceScript(Scene, {
      quantum: 1,
      print: (_scene, text) => output.push(text),
      finish: () => finished.resolve(),
    });
    const scene = new Scene(),
      session = adapter.attach(scene, story("Timer."));
    assert.equal(session.run().status, "running");
    await finished.promise;
    assert.equal(session.machine.state.done, true);
    assert.deepEqual(output, ["Timer."]);
  },
);

test("global-only native interfaces need no source-scene inventory", { skip: !process.env.CHOICESCRIPT_ENGINE }, () => {
  const program = story();
  program.legacy_globals = { "original.calls": { ty: { kind: "int" }, mutable: true, target: "calls" } };
  delete program.legacy_sources;
  program.functions[program.entry].code = [
    { op: "load", name: "original.calls", span },
    { op: "format", count: 1, span },
    { op: "print", span },
    { op: "constant", ty: { kind: "unit" }, value: null, span },
    { op: "return", span },
  ];
  const context = nativeEngineHost(process.env.CHOICESCRIPT_ENGINE, {}, { calls: 11 }),
    output = [];
  const adapter = installChoiceScript(context.context.Scene, { print: (_scene, text) => output.push(text) });
  assert.equal(adapter.attach(context.parent, program).run().status, "done");
  assert.deepEqual(output, ["11"]);
  assert.equal(context.stats.calls, 11);
});
