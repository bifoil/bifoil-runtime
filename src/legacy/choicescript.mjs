// Run delimited native subroutines using the unchanged engine's parser, command
// dispatcher and print loop. Only loading, presentation and the bridge return
// boundary are adapted; ordinary engine scenes retain their original execute.
import { check, BifoilError } from "../errors.mjs";
import { encodeState, decodeState } from "./state.mjs";
import { installInput, submitInput, validateInput } from "./input.mjs";
import { installOutput, publishOutput } from "./output.mjs";

const installations = new WeakMap();
const protectedStats = new Set(["scene", "bifoil_checkpoint"]);
const sceneFields = [
  "name",
  "temps",
  "lineNum",
  "indent",
  "prevLine",
  "screenEmpty",
  "initialCommands",
  "accumulatedParagraph",
  "debugMode",
  "secondaryMode",
  "saveSlot",
];

function routing(Scene) {
  if (installations.has(Scene)) return installations.get(Scene);
  const active = new WeakMap(),
    execute = Scene.prototype.execute;
  check(typeof execute === "function", "ChoiceScript execute method required");
  Scene.prototype.execute = function (...arguments_) {
    const driver = active.get(this.stats);
    return driver ? driver.execute(this) : execute.apply(this, arguments_);
  };
  installations.set(Scene, active);
  return active;
}
function readStats(stats, target) {
  const name = target.toLowerCase();
  check(Object.hasOwn(stats, name), "missing legacy variable " + target);
  return stats[name];
}
function statValues(stats) {
  return Object.fromEntries(Object.entries(stats).filter(([key]) => !protectedStats.has(key)));
}
function restoreStats(stats, saved) {
  check(saved && typeof saved === "object" && !Array.isArray(saved), "invalid native statistics");
  for (const key of Object.keys(stats)) if (!protectedStats.has(key)) delete stats[key];
  for (const [key, value] of Object.entries(saved)) {
    check(!protectedStats.has(key), "invalid protected legacy statistic");
    Object.defineProperty(stats, key, { value, writable: true, configurable: true, enumerable: true });
  }
}

function navigationValues(nav) {
  if (!nav) return null;
  const values = {};
  for (const key in nav) if (typeof nav[key] !== "function") values[key] = nav[key];
  return values;
}
function restoreNavigation(nav, saved) {
  if (saved === null) {
    check(!nav, "missing saved native navigation");
    return;
  }
  check(nav && saved && typeof saved === "object" && !Array.isArray(saved), "invalid native navigation");
  for (const key of Object.keys(nav)) if (typeof nav[key] !== "function") delete nav[key];
  for (const [key, value] of Object.entries(saved))
    Object.defineProperty(nav, key, { value, writable: true, configurable: true, enumerable: true });
}

class NativeCall {
  constructor(host, request) {
    this.host = host;
    this.request = request;
    this.output = [];
    this.wait = null;
    this.returned = false;
    this.transferred = false;
    this.steps = 0;
  }
  paragraph(scene) {
    const text = scene.accumulatedParagraph.join("").trim();
    if (text) this.output.push(text);
    scene.accumulatedParagraph = [];
    scene.prevLine = "empty";
    publishOutput(this);
  }
  prepare(scene) {
    if (scene.bifoilNativeCall === this) return;
    const source = this.host.sources[scene.name.toLowerCase()];
    check(typeof source === "string", "missing native scene " + scene.name);
    scene.loadLines(source);
    Object.defineProperty(scene, "bifoilNativeCall", { value: this, configurable: true });
    scene.paragraph = () => this.paragraph(scene);
    // VM snapshots replace automatic host saves at these native input waits.
    scene.save = () => {};
    const requireTransfer = () =>
      check(this.request.target.transfer === true, "legacy control transfer requires an explicit transfer bridge");
    scene.ending = () => {
      requireTransfer();
      this.paragraph(scene);
      scene.finished = true;
      this.transferred = true;
    };
    scene.abort = () => scene.ending();
    scene.finish = (buttonName) => {
      requireTransfer();
      const next = scene.nav?.nextSceneName(scene.name);
      this.paragraph(scene);
      scene.finished = true;
      if (!next) scene.ending();
      else if (scene.screenEmpty) scene.goto_scene(next);
      else
        this.wait = {
          kind: "chapter",
          scene: next,
          selections: [{ label: scene.replaceVariables(buttonName || "Next Chapter"), enabled: true }],
        };
    };
    scene.autofinish = () => {
      if (this.request.target.transfer) scene.finish();
      else throw new BifoilError("legacy subroutine reached the end without *return");
    };
    const gotoScene = this.host.Scene.prototype.goto_scene;
    scene.goto_scene = (data, isGosubScene) => {
      if (!isGosubScene) requireTransfer();
      return gotoScene.call(scene, data, isGosubScene);
    };
    scene.resetPage = () => {
      scene.resetCheckedPurchases();
      scene.prevLine = "empty";
      scene.screenEmpty = true;
      scene.execute();
    };
    const nativeReturn = this.host.Scene.prototype["return"];
    scene["return"] = () => {
      const stack = scene.stats.choice_subscene_stack;
      if (!scene.temps.choice_substack?.length && stack?.at(-1)?.bifoil_bridge === true) {
        stack.pop();
        scene.finished = true;
        scene.skipFooter = true;
        this.paragraph(scene);
        this.returned = true;
      } else nativeReturn.call(scene);
    };
    const runCommand = this.host.Scene.prototype.runCommand;
    scene.runCommand = (line) => {
      check(++this.steps <= 1000000, "legacy execution step budget exceeded");
      return runCommand.call(scene, line);
    };
    scene.renderOptions = (groups, options) => {
      const selections = [];
      const visit = (items, labels, enabled) => {
        for (const option of items) {
          option.name = scene.replaceVariables(option.name);
          const path = [...labels, option.name],
            available = enabled && !option.unselectable;
          if (option.suboptions) visit(option.suboptions, path, available);
          else selections.push({ option, label: path.join(" / "), enabled: available });
        }
      };
      visit(options, [], true);
      this.paragraph(scene);
      this.wait = { kind: "choice", selections };
    };
    installOutput(scene, this);
    installInput(scene, this);
    scene.page_break = (buttonName) => {
      if (scene.screenEmpty) return;
      const label = scene.replaceVariables(buttonName || "Next");
      this.paragraph(scene);
      scene.finished = true;
      this.wait = { kind: "page", selections: [{ label, enabled: true }] };
    };
  }
  execute(scene) {
    this.current = scene;
    this.prepare(scene);
    if (scene.targetLabel !== undefined) {
      scene["goto"](scene.targetLabel.label);
      delete scene.targetLabel;
    }
    check(scene.checkSum(), "native source changed during a bridge call");
    if (scene.nav?.repairStats) scene.nav.repairStats(scene.stats);
    scene.temps._choiceEnds ??= {};
    scene.skipFooter = true;
    scene.printLoop();
  }
  reply() {
    const output = this.output.splice(0);
    if (this.returned || this.transferred) {
      this.host.active.delete(this.host.parent.stats);
      this.host.parent.stats.scene = this.host.parent;
      this.host.parent.stats.sceneName = this.host.parent.name;
      return {
        status: this.transferred ? "transferred" : "returned",
        value: this.request.target.result === null ? undefined : this.host.read(this.request.target.result),
        output,
      };
    }
    check(this.wait, "native routine stopped outside a supported input wait");
    const scene = Object.fromEntries(
      sceneFields.filter((key) => this.current[key] !== undefined).map((key) => [key, this.current[key]]),
    );
    return {
      status: "waiting",
      output,
      ...(this.wait.input ? { input: this.wait.input } : {}),
      options: this.wait.selections.map(({ label, enabled }) => ({ label, enabled })),
      continuation: encodeState({
        scene,
        stats: statValues(this.host.parent.stats),
        navigation: navigationValues(this.host.parent.nav),
        wait: this.wait,
      }),
    };
  }
}

export function createChoiceScriptHost(Scene, parent, sources = {}, { publishOutput = null } = {}) {
  check(Scene?.prototype && parent?.stats, "ChoiceScript scene and statistics required");
  check(publishOutput === null || typeof publishOutput === "function", "invalid native output publisher");
  const active = routing(Scene);
  const host = {
    Scene,
    parent,
    sources,
    active,
    publishOutput,
    read(target) {
      return readStats(parent.stats, target);
    },
    write(target, value) {
      readStats(parent.stats, target);
      parent.stats[target.toLowerCase()] = value;
    },
    snapshot() {
      return encodeState({ stats: statValues(parent.stats), navigation: navigationValues(parent.nav) });
    },
    restore(snapshot) {
      const saved = decodeState(snapshot);
      restoreStats(parent.stats, saved.stats);
      restoreNavigation(parent.nav, saved.navigation);
      parent.stats.scene = parent;
    },
    cancel() {
      const call = active.get(parent.stats);
      if (!call || call.host !== host) return;
      active.delete(parent.stats);
      if (call?.request.target.transfer) delete parent.stats.choice_subscene_stack;
      else {
        const stack = parent.stats.choice_subscene_stack;
        const boundary = stack?.findLastIndex((frame) => frame.bifoil_bridge === true) ?? -1;
        if (boundary >= 0) stack.splice(boundary);
      }
      parent.stats.scene = parent;
      parent.stats.sceneName = parent.name;
    },
    start(request) {
      check(!active.has(parent.stats), "legacy bridge cannot reenter an active native call");
      const call = new NativeCall(host, request);
      if (request.target.transfer) delete parent.stats.choice_subscene_stack;
      else {
        parent.stats.choice_subscene_stack ??= [];
        parent.stats.choice_subscene_stack.push({
          name: parent.name,
          lineNum: parent.lineNum,
          indent: parent.indent,
          temps: parent.temps,
          bifoil_bridge: true,
        });
      }
      active.set(parent.stats, call);
      const scene = new Scene(request.target.scene, parent.stats, parent.nav);
      scene.temps.param = request.args.slice();
      if (request.target.label !== null) scene.targetLabel = { label: request.target.label };
      try {
        call.execute(scene);
        return call.reply();
      } catch (failure) {
        host.cancel();
        call.paragraph(call.current);
        failure.legacyOutput = call.output.splice(0);
        throw failure;
      }
    },
    resume(request, continuation, index) {
      const saved = decodeState(continuation);
      check(saved?.scene && saved.wait && Array.isArray(saved.wait.selections), "invalid native input continuation");
      const selected = saved.wait.selections[index];
      if (saved.wait.kind === "input") validateInput(saved.wait.input);
      else check(selected?.enabled, "invalid native selection");
      restoreStats(parent.stats, saved.stats);
      restoreNavigation(parent.nav, saved.navigation);
      const call = new NativeCall(host, request);
      active.set(parent.stats, call);
      const scene = new Scene(saved.scene.name, parent.stats, parent.nav);
      call.prepare(scene);
      Object.assign(scene, saved.scene);
      call.current = scene;
      try {
        if (saved.wait.kind === "input") submitInput(scene, call, saved.wait, index);
        else if (saved.wait.kind === "choice") scene.standardResolution(selected.option);
        else if (saved.wait.kind === "chapter") {
          scene.goto_scene(saved.wait.scene);
        } else {
          check(saved.wait.kind === "page", "unsupported native input kind");
          scene.finished = false;
          scene.resetPage();
        }
        return call.reply();
      } catch (failure) {
        host.cancel();
        call.paragraph(call.current);
        failure.legacyOutput = call.output.splice(0);
        throw failure;
      }
    },
  };
  return host;
}
