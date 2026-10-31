// Original compiled-package fixtures shared by runtime and engine acceptance.
import { createHash } from "node:crypto";
import { PACKAGE_FORMAT, CODE_FORMAT } from "../../src/packages.mjs";
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");

export function splitCompiledProgram(program) {
  const groups = new Map(),
    sources = new Map(),
    chunks = {},
    modules = {};
  for (const [id, fn] of Object.entries(program.functions)) {
    const module = id.split(".")[0];
    if (!groups.has(module)) groups.set(module, {});
    groups.get(module)[id] = fn;
  }
  for (const [module, functions] of groups) {
    const json = JSON.stringify({ format: CODE_FORMAT, profile: "bifoil-vm.v2", module, functions });
    const scene = "bifoil_code_" + hash(json);
    modules[module] = hash("module:" + module);
    chunks[module] = { scene, module_digest: modules[module] };
    sources.set(scene, "*comment compiled fixture\n*bifoil_module " + json + "\n*return\n");
  }
  const manifest = { ...program, format: PACKAGE_FORMAT, profile: "bifoil-vm.v2", modules, functions: {}, chunks };
  const startup = "*bifoil " + JSON.stringify(manifest) + "\n";
  return { manifest, sources, startup };
}
