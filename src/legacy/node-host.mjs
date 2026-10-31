// Explicit-path headless host for original ChoiceScript conformance sources.
// Engine and utility implementations are read from the supplied checkout.
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createChoiceScriptHost } from "./choicescript.mjs";

export function nativeEngineHost(engine, sources = {}, initial = {}, options = {}) {
  const directory = dirname(engine);
  const context = vm.createContext({ console, setTimeout, clearTimeout, stats: initial });
  for (const file of ["util.js", "navigator.js"])
    vm.runInContext(readFileSync(join(directory, file), "utf8"), context, { filename: file });
  vm.runInContext(readFileSync(engine, "utf8"), context, { filename: "upstream-scene.js" });
  const nav = new context.SceneNavigator(Object.keys(sources));
  nav.setStartingStatsClone(initial);
  context.nav = nav;
  const parent = new context.Scene("bifoil_host", initial, nav);
  const host = createChoiceScriptHost(context.Scene, parent, sources, options);
  return { host, stats: initial, context, parent };
}
