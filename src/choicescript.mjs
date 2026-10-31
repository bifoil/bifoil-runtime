import { print as defaultPrint, renderChoice, renderInput } from "./presentation.mjs";
import { createChoiceScriptHost } from "./legacy/choicescript.mjs";
import { VM, BifoilError } from "./vm.mjs";
import { PACKAGE_FORMAT, loadPackage, validCodeScene, validateCodeChunk } from "./packages.mjs";

/**
 * Register the explicit Bifoil instruction command without editing the ChoiceScript engine.
 * Host hooks receive already formatted text. They must not interpolate it a second time.
 */
export function installChoiceScript(Scene, hooks = {}) {
  if (!Scene?.validCommands || !Scene.prototype) throw new BifoilError("ChoiceScript Scene constructor required");
  const staged = new WeakMap();
  const print = hooks.print ?? defaultPrint;
  const render = hooks.renderChoice ?? renderChoice;
  const showInput = hooks.renderInput ?? ((scene, input, submit) => renderInput(scene, input, submit, print));
  function attach(scene, program, checkpoint = null) {
    const previous = scene.bifoilSession;
    const releasePrevious = () => previous?.machine?.legacy?.cancel?.();
    const needsLegacy =
      Object.keys(program.legacy_globals ?? {}).length > 0 || Object.keys(program.legacy_sources ?? {}).length > 0;
    let machine;
    const publishNativeOutput = (paragraphs) => {
      if (!machine || scene.bifoilSession?.machine !== machine)
        throw new BifoilError("Bifoil session has been replaced");
      machine.flushProse();
      for (const paragraph of paragraphs) machine.emitOutput(paragraph);
      for (const paragraph of machine.drainOutput()) {
        assertAttached();
        print(scene, paragraph);
      }
      assertAttached();
    };
    const legacy =
      hooks.legacy?.(scene, program, { publishOutput: publishNativeOutput }) ??
      (needsLegacy
        ? createChoiceScriptHost(Scene, scene, program.legacy_sources ?? {}, { publishOutput: publishNativeOutput })
        : null);
    machine =
      checkpoint === null
        ? new VM(program, null, { legacy, quantum: hooks.quantum ?? 10000 })
        : VM.restore(program, checkpoint, { legacy, quantum: hooks.quantum ?? 10000, beforeRestore: releasePrevious });
    if (checkpoint === null) releasePrevious();
    let generation = 0;
    let selected = false;
    const attached = () => scene.bifoilSession === session;
    const assertAttached = () => {
      if (!attached()) throw new BifoilError("Bifoil session has been replaced");
    };
    const advance = (operation) => {
      assertAttached();
      try {
        return pump(operation());
      } catch (error) {
        if (machine.failure && attached()) {
          generation++;
          selected = true;
          delete scene.stats.bifoil_checkpoint;
          for (const paragraph of machine.drainOutput()) print(scene, paragraph);
        }
        throw error;
      }
    };
    const pump = (result) => {
      if (!attached()) return result;
      generation++;
      selected = false;
      scene.finished = true;
      for (const paragraph of result.output) {
        if (!attached()) return result;
        print(scene, paragraph);
      }
      if (!attached()) return result;
      if (result.status === "running") {
        delete scene.stats.bifoil_checkpoint;
        const schedule = hooks.schedule ?? ((continueExecution) => globalThis.setTimeout(continueExecution, 0));
        const ticket = generation;
        schedule(() => {
          if (attached() && ticket === generation) advance(() => machine.run());
        });
      } else if (result.status === "waiting") {
        scene.stats.bifoil_checkpoint = machine.save();
        const ticket = generation;
        const respond = (response) => {
          if (!attached() || selected || ticket !== generation) throw new BifoilError("stale choice callback");
          // A disabled/invalid selection leaves the existing callback usable.
          return advance(() => {
            const next = result.input ? machine.submit(response) : machine.choose(response);
            selected = true;
            return next;
          });
        };
        if (result.input) showInput(scene, result.input, respond);
        else render(scene, result.options, respond);
      } else {
        delete scene.stats.bifoil_checkpoint;
        hooks.finish?.(scene);
      }
      return result;
    };
    const session = {
      machine,
      run: () => advance(() => machine.run()),
      save: () => {
        assertAttached();
        return machine.save();
      },
    };
    scene.bifoilSession = session;
    delete scene.bifoilLoading;
    delete scene.bifoilFailure;
    return session;
  }
  Scene.validCommands.bifoil_module = 1;
  Scene.prototype.bifoil_module = function (data) {
    if (!validCodeScene(this.name) || !this.stats || typeof this.stats !== "object")
      throw new BifoilError("compiled code scene context required");
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new BifoilError("invalid compiled code chunk JSON");
    }
    validateCodeChunk(chunk);
    if (!staged.has(this.stats)) staged.set(this.stats, new Map());
    staged.get(this.stats).set(this.name, "*bifoil_module " + data + "\n*return\n");
  };
  function startPackage(scene, manifest) {
    const code = staged.get(scene.stats) ?? new Map();
    staged.delete(scene.stats);
    scene.bifoilSession?.machine?.legacy?.cancel?.();
    // This placeholder replaces old sessions immediately and doubles as the
    // cancellation token across detach, restore, and adapter reinstallation.
    const pending = {};
    scene.bifoilSession = pending;
    scene.finished = true;
    let started = null;
    const ready = loadPackage(
      manifest,
      (name) => {
        if (!code.has(name)) throw new BifoilError("compiled code scene was not loaded: " + name);
        const source = code.get(name);
        code.delete(name);
        return source;
      },
      { digest: hooks.digest },
    ).then((program) => {
      if (scene.bifoilSession !== pending) return null;
      started = attach(scene, program);
      if (scene.bifoilLoading === ready) delete scene.bifoilLoading;
      started.run();
      return started;
    });
    scene.bifoilLoading = ready;
    ready.catch((error) => {
      if (scene.bifoilLoading === ready) delete scene.bifoilLoading;
      if (scene.bifoilSession !== pending && scene.bifoilSession !== started) return;
      if (scene.bifoilSession === pending) delete scene.bifoilSession;
      scene.bifoilFailure = error;
      if (hooks.error) hooks.error(scene, error);
      else print(scene, error.message);
    });
  }
  Scene.validCommands.bifoil = 1;
  Scene.prototype.bifoil = function (data) {
    let program;
    try {
      program = JSON.parse(data);
    } catch {
      throw new BifoilError("invalid compiled program JSON");
    }
    if (program?.format === PACKAGE_FORMAT) startPackage(this, program);
    else attach(this, program).run();
  };
  // The save host restores normal ChoiceScript stats, then explicitly attaches this session.
  // This avoids rerunning the command or relying on the engine's incremented line number.
  return {
    attach,
    detach(scene) {
      scene.bifoilSession?.machine?.legacy?.cancel?.();
      delete scene.bifoilSession;
      delete scene.bifoilLoading;
    },
    restore(scene, program, checkpoint = scene.stats.bifoil_checkpoint) {
      const session = attach(scene, program, checkpoint);
      session.run();
      return session;
    },
  };
}
