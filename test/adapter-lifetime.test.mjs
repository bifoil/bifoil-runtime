import { nativeEngineHost } from "../src/legacy/node-host.mjs";
import { createChoiceScriptHost } from "../src/legacy/choicescript.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installChoiceScript } from "../src/choicescript.mjs";

const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
function sceneType() {
  class Scene {
    constructor() {
      this.stats = {};
    }
  }
  Scene.validCommands = {};
  return Scene;
}

test("replacing a scene session cancels its scheduled continuation and rejects held session handles", () => {
  const Scene = sceneType();
  const scheduled = [];
  const adapter = installChoiceScript(Scene, {
    quantum: 1,
    schedule: (callback) => scheduled.push(callback),
    print() {},
    renderChoice() {},
  });
  const scene = new Scene();
  const previous = adapter.attach(scene, fixture());
  previous.run();
  const before = JSON.stringify(previous.machine.state);
  const callback = scheduled.shift();
  const replacement = adapter.attach(scene, fixture());
  callback();
  assert.ok(JSON.stringify(previous.machine.state) === before, "a replaced session must not advance");
  assert.equal(scene.bifoilSession, replacement);
  assert.throws(() => previous.run(), /replaced/);
  assert.throws(() => previous.save(), /replaced/);
});

test("restoring a waiting scene invalidates old choices without deleting the replacement checkpoint", () => {
  const Scene = sceneType();
  const callbacks = [],
    output = [];
  const adapter = installChoiceScript(Scene, {
    print: (scene, text) => output.push(text),
    renderChoice: (scene, options, callback) => callbacks.push(callback),
  });
  const scene = new Scene();
  const previous = adapter.attach(scene, fixture());
  previous.run();
  const checkpoint = scene.stats.bifoil_checkpoint;
  adapter.restore(scene, fixture(), checkpoint);
  assert.throws(() => callbacks[0](0), /stale/);
  assert.equal(scene.stats.bifoil_checkpoint, checkpoint);
  assert.deepEqual(output, []);
  callbacks[1](0);
  assert.deepEqual(output, ["Result 12; counter 2; next 3; after 3."]);
});

test("a rejected replacement leaves the existing prepared session usable", () => {
  const Scene = sceneType();
  let choose;
  const adapter = installChoiceScript(Scene, {
    print() {},
    renderChoice: (scene, options, callback) => (choose = callback),
  });
  const scene = new Scene();
  const previous = adapter.attach(scene, fixture());
  previous.run();
  assert.throws(() => adapter.restore(scene, fixture(), "{}"), /different build/);
  assert.equal(scene.bifoilSession, previous);
  assert.equal(choose(0).status, "done");
});

const engine = process.env.CHOICESCRIPT_ENGINE;
const legacyProgram = () => JSON.parse(readFileSync(new URL("./fixtures/legacy.json", import.meta.url), "utf8"));
function nativeAdapter() {
  const program = legacyProgram();
  const context = nativeEngineHost(engine, program.legacy_sources, { calls: 0, answer: 0 });
  const callbacks = [];
  const adapter = installChoiceScript(context.context.Scene, {
    print() {},
    renderChoice: (scene, options, callback) => callbacks.push(callback),
  });
  return { ...context, program, adapter, callbacks };
}

test("replacing an active native wait releases its old bridge before starting another", { skip: !engine }, () => {
  const { parent, program, adapter, callbacks } = nativeAdapter();
  adapter.attach(parent, program).run();
  assert.equal(parent.stats.calls, 2);
  const replacement = adapter.attach(parent, program);
  assert.equal(replacement.run().options[0].label, "Take 4");
  assert.throws(() => callbacks[0](0), /stale/);
});

test(
  "native restoration releases the previous bridge after validation and before restoring external state",
  { skip: !engine },
  () => {
    const { parent, program, adapter, callbacks } = nativeAdapter();
    const original = adapter.attach(parent, program);
    original.run();
    const nativeScene = parent.stats.scene;
    assert.throws(() => adapter.restore(parent, program, "{}"), /different build/);
    assert.equal(parent.stats.scene, nativeScene);
    const checkpoint = original.save();
    const restored = adapter.restore(parent, program, checkpoint);
    assert.equal(parent.stats.calls, 2);
    assert.throws(() => callbacks[0](0), /stale/);
    assert.equal(callbacks[1](0).options[0].label, "Finish 3");
    assert.equal(restored.machine.state.pending.kind, undefined);
  },
);

test(
  "a native host cannot cancel a wait owned by a different host sharing the same statistics",
  { skip: !engine },
  () => {
    const { host, parent, context, stats } = nativeEngineHost(engine, {
      native: "*choice\n    #Continue\n        *return\n",
    });
    const request = { target: { scene: "native", label: null, result: null }, suspend: true, args: [] };
    assert.equal(host.start(request).status, "waiting");
    const nativeScene = stats.scene;
    const other = createChoiceScriptHost(context.Scene, parent, { native: "*return\n" });
    other.cancel();
    assert.equal(stats.scene, nativeScene);
    host.cancel();
    assert.equal(stats.scene, parent);
  },
);

test("detaching a host scene invalidates its controls while retaining an already serialized checkpoint", () => {
  const Scene = sceneType();
  let choose;
  const adapter = installChoiceScript(Scene, {
    print() {},
    renderChoice: (scene, options, callback) => (choose = callback),
  });
  const scene = new Scene();
  const session = adapter.attach(scene, fixture());
  session.run();
  const checkpoint = scene.stats.bifoil_checkpoint;
  adapter.detach(scene);
  assert.equal(scene.bifoilSession, undefined);
  assert.equal(scene.stats.bifoil_checkpoint, checkpoint);
  assert.throws(() => choose(0), /stale/);
  assert.throws(() => session.run(), /replaced/);
});
