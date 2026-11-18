import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { setImmediate } from "node:timers/promises";
import { parseHTML } from "linkedom";
import { mockModule } from "./module-mocks.mjs";
import { savePresentation, readPresentation } from "../tools/browser-save.mjs";
import { VM } from "../src/vm.mjs";

let sequence = 0;
function browser(t, { selected = "browser", remembered = selected, saved = null, fetchFails = false } = {}) {
  const { window, document } = parseHTML(readFileSync(new URL("../tools/browser-host.html", import.meta.url), "utf8"));
  const fixture = document.getElementById("fixture");
  const option = document.createElement("option");
  option.value = "browser-package";
  fixture.append(option);
  let value = selected;
  Object.defineProperty(fixture, "value", {
    get: () => value,
    set: (next) => {
      value = next;
    },
  });
  const stored = new Map([["bifoil.browser.acceptance.fixture", remembered]]);
  if (saved) stored.set("bifoil.browser.acceptance." + selected, saved);
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, item) => stored.set(key, String(item)),
  };
  for (const [name, item] of Object.entries({
    window,
    document,
    localStorage: storage,
    MutationObserver: window.MutationObserver,
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value: item, configurable: true, writable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  const operations = [],
    program = { fixture: "original" };
  const adapter = {
    attach(scene, value, checkpoint) {
      operations.push(["attach", value, checkpoint]);
      scene.bifoilSession = { machine: { program: value, state: { done: false } }, save: () => "execution-checkpoint" };
      scene.stats.bifoil_checkpoint = "execution-checkpoint";
      return {
        run: () => {
          operations.push(["run", document.getElementById("main").innerHTML]);
          document.getElementById("text")?.append("Original story");
        },
      };
    },
    detach(scene) {
      operations.push(["detach", scene]);
    },
  };
  class Scene {
    static baseUrl = "/engine";
    constructor(_name, stats) {
      this.stats = stats;
    }
    runCommand(command) {
      operations.push(["command", command]);
      adapter.attach(this, program).run();
    }
    loadLines(source) {
      operations.push(["loadLines", source]);
    }
    execute() {
      operations.push(["execute"]);
      adapter.attach(this, program).run();
    }
  }
  window.Scene = Scene;
  window.SceneNavigator = class {
    setStartingStatsClone(stats) {
      operations.push(["stats", stats]);
    }
  };
  t.mock.method(globalThis, "fetch", async (route) => {
    operations.push(["fetch", route]);
    return new Response(route.startsWith("/package/") ? "compiled-source" : JSON.stringify(program), {
      status: fetchFails ? 404 : 200,
    });
  });
  t.mock.method(console, "error", () => {});
  let adapterHooks;
  mockModule(t, "/runtime/src/choicescript.mjs", {
    exports: {
      installChoiceScript: (_Scene, hooks) => {
        adapterHooks = hooks;
        return adapter;
      },
    },
  });
  mockModule(t, "/runtime/src/packages.mjs", {
    exports: {
      loadCompiledProgram: async () => {
        operations.push(["read-package"]);
        return program;
      },
    },
  });
  mockModule(t, "/runtime/src/browser-code.mjs", { exports: { readBrowserCode: async () => "code" } });
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "/browser-save.mjs")
        return next(new URL("../tools/browser-save.mjs", import.meta.url).href, context);
      return next(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  return { window, document, fixture, stored, operations, program, finish: () => adapterHooks.finish() };
}
async function loadHost() {
  await import(new URL(`../tools/browser-host.mjs?test=${++sequence}`, import.meta.url).href);
}
async function click(browser, name) {
  browser.document.getElementById(name).dispatchEvent(new browser.window.Event("click"));
  await setImmediate();
}

test("presentation saves keep narrative but remove all interactive controls", () => {
  const { document } = parseHTML(
    "<main>Story<form>form<input></form><button>choice</button><select></select><textarea></textarea></main>",
  );
  const main = document.querySelector("main");
  const saved = readPresentation(savePresentation("checkpoint", main));
  assert.equal(saved.checkpoint, "checkpoint");
  assert.equal(saved.presentation, "Story");
  assert.ok(main.querySelector("form"));
  assert.deepEqual(readPresentation("{}"), { checkpoint: "{}", presentation: null });
  for (const value of [
    { checkpoint: 3, presentation: "text" },
    { checkpoint: "ok", presentation: null },
  ])
    assert.throws(
      () => readPresentation(JSON.stringify({ format: "bifoil.browser-save.v1", ...value })),
      /Invalid browser/,
    );
});
test("browser controls save, restore and restart without replaying scene commands", async (t) => {
  const b = browser(t);
  await loadHost();
  assert.equal(b.operations.filter(([name]) => name === "command").length, 1);
  assert.equal(b.document.getElementById("status").textContent, "Waiting for input");
  await click(b, "save");
  const saved = b.stored.get("bifoil.browser.acceptance.browser");
  assert.equal(readPresentation(saved).checkpoint, "execution-checkpoint");
  await click(b, "load");
  assert.equal(b.operations.filter(([name]) => name === "command").length, 1);
  assert.equal(b.operations.filter(([name]) => name === "attach").at(-1)[2], "execution-checkpoint");
  await click(b, "restart");
  assert.equal(b.window.stats.calls, 0);
  assert.equal(b.window.stats.answer, "");
  b.stored.delete("bifoil.browser.acceptance.browser");
  await click(b, "load");
  assert.equal(b.document.getElementById("status").textContent, "No saved checkpoint");
  b.fixture.value = "browser-native";
  b.fixture.dispatchEvent(new b.window.Event("change"));
  await setImmediate();
  assert.equal(b.stored.get("bifoil.browser.acceptance.fixture"), "browser-native");
  assert.ok(b.operations.some(([name, value]) => name === "fetch" && value === "/fixtures/browser-native.json"));
});
test("browser package restoration validates execution before replacing presentation", async (t) => {
  const saved = JSON.stringify({
    format: "bifoil.browser-save.v1",
    checkpoint: "saved",
    presentation: '<div id="text">Earlier story</div>',
  });
  const b = browser(t, { selected: "browser-package", saved });
  await loadHost();
  assert.ok(b.operations.some(([name]) => name === "read-package"));
  assert.equal(b.operations.filter(([name]) => name === "execute").length, 0);
  assert.equal(b.operations.find(([name]) => name === "attach")[2], "saved");
  assert.match(b.operations.find(([name]) => name === "run")[1], /Earlier story/);
  assert.equal(b.window.Scene.baseUrl, "/package");
});
test("browser starts unsaved packages through the engine and reports fetch failures", async (t) => {
  const b = browser(t, { selected: "browser-package" });
  await loadHost();
  assert.ok(b.operations.some(([name, value]) => name === "loadLines" && value === "compiled-source"));
  assert.ok(b.operations.some(([name]) => name === "execute"));
  const event = new b.window.Event("error");
  event.message = "Browser failure";
  b.window.dispatchEvent(event);
  assert.equal(b.document.getElementById("status").textContent, "Browser failure");
});
test("browser reports unavailable fixtures without executing story code", async (t) => {
  const b = browser(t, { fetchFails: true });
  await loadHost();
  assert.equal(b.document.getElementById("status").textContent, "Cannot load original browser fixture");
  assert.equal(b.operations.filter(([name]) => name === "command").length, 0);
});

test("unknown remembered fixtures retain the default and completion follows current execution state", async (t) => {
  const b = browser(t, { remembered: "removed-fixture" });
  await loadHost();
  assert.equal(b.fixture.value, "browser");
  assert.equal(b.operations.filter(([name]) => name === "command").length, 1);
  delete b.window.stats.bifoil_checkpoint;
  b.finish();
  assert.equal(b.document.getElementById("status").textContent, "Running");
  b.window.stats.scene.bifoilSession.machine.state.done = true;
  b.finish();
  assert.equal(b.document.getElementById("status").textContent, "Finished");
  assert.equal(b.document.getElementById("save").disabled, true);
});

test("earlier plain checkpoints restore inline fixtures without replaying their commands", async (t) => {
  const input = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  const machine = new VM(input);
  assert.equal(machine.run().status, "waiting");
  const saved = machine.save();
  const b = browser(t, { saved });
  await loadHost();
  assert.equal(b.operations.filter(([name]) => name === "command").length, 0);
  assert.equal(b.operations.find(([name]) => name === "attach")[2], saved);
  assert.equal(b.operations.find(([name]) => name === "run")[1], '<div id="text"></div>');
});
