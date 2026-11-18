import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installChoiceScript } from "../src/choicescript.mjs";

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

function story(paragraphs) {
  const program = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  const entry = program.functions[program.entry];
  const span = { file: "src/original.bfl", line: 1 };
  entry.code = paragraphs.flatMap((value) => [
    { op: "constant", ty: { kind: "string" }, value, span },
    { op: "print", span },
  ]);
  entry.code.push({ op: "constant", ty: { kind: "unit" }, value: null, span }, { op: "return", span });
  program.functions = { [program.entry]: entry };
  return program;
}

test("adapter registration rejects missing constructor metadata before installing commands", () => {
  for (const invalid of [undefined, null, {}, { validCommands: {} }])
    assert.throws(() => installChoiceScript(invalid), /Scene constructor required/);
  const Scene = sceneType();
  assert.equal(typeof installChoiceScript(Scene).attach, "function");
  assert.equal(Scene.validCommands.bifoil, 1);
});

test("reentrant output detachment stops both later paragraphs and final presentation", () => {
  for (const paragraphs of [["First."], ["First.", "Retired second."]]) {
    const Scene = sceneType();
    const printed = [];
    let finishes = 0;
    const adapter = installChoiceScript(Scene, {
      print(scene, text) {
        printed.push(text);
        adapter.detach(scene);
      },
      finish() {
        finishes++;
      },
    });
    const scene = new Scene();
    const session = adapter.attach(scene, story(paragraphs));
    assert.equal(session.run().status, "done");
    assert.deepEqual(printed, ["First."]);
    assert.equal(finishes, 0);
    assert.equal(scene.bifoilSession, undefined);
    assert.throws(() => session.run(), /replaced/);
  }
});

test("a native publisher cannot emit before initialization or after session replacement", () => {
  const Scene = sceneType();
  let publish;
  const printed = [];
  const adapter = installChoiceScript(Scene, {
    legacy(_scene, _program, options) {
      publish = options.publishOutput;
      assert.throws(() => publish(["Premature."]), /session has been replaced/);
      return null;
    },
    print(_scene, text) {
      printed.push(text);
    },
  });
  const scene = new Scene();
  adapter.attach(scene, story([])).run();
  publish(["Owned native output."]);
  assert.deepEqual(printed, ["Owned native output."]);
  const retired = publish;
  adapter.attach(scene, story([]));
  assert.throws(() => retired(["Obsolete native output."]), /session has been replaced/);
  assert.deepEqual(printed, ["Owned native output."]);
});

test("detaching inside a native output callback prevents the rest of that publication", () => {
  const Scene = sceneType();
  let publish;
  const printed = [];
  const adapter = installChoiceScript(Scene, {
    legacy(_scene, _program, options) {
      publish = options.publishOutput;
      return null;
    },
    print(scene, text) {
      printed.push(text);
      adapter.detach(scene);
    },
  });
  const scene = new Scene();
  adapter.attach(scene, story([])).run();
  assert.throws(() => publish(["Visible.", "Retired."]), /session has been replaced/);
  assert.deepEqual(printed, ["Visible."]);
});

test("compiled chunk staging refuses primitive statistics even with a valid code-scene identity", () => {
  const Scene = sceneType();
  installChoiceScript(Scene);
  const scene = new Scene();
  scene.name = "bifoil_code_" + "a".repeat(64);
  for (const stats of [null, undefined, 0, "invalid"]) {
    scene.stats = stats;
    assert.throws(() => scene.bifoil_module("{}"), /compiled code scene context required/);
  }
});
