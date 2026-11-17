import { summarizeFunction } from "../../src/code-metadata.mjs";
// Original compiled-package fixtures shared by runtime and engine acceptance.
import { createHash } from "node:crypto";
import { LAZY_PACKAGE_FORMAT, PACKAGE_FORMAT, CODE_FORMAT } from "../../src/packages.mjs";
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");

export function splitCompiledProgram(program, { lazy = false } = {}) {
  // Original v1 fixture bodies already supported the extended package tests;
  // preserve that test adaptation while retaining newer profiles exactly.
  const profile = program.profile === "bifoil-vm.v1" ? "bifoil-vm.v2" : program.profile;
  const groups = new Map(),
    sources = new Map(),
    chunks = Object.create(null),
    modules = Object.create(null);
  for (const [id, fn] of Object.entries(program.functions)) {
    const module = id.split(".")[0];
    if (!groups.has(module)) groups.set(module, {});
    groups.get(module)[id] = fn;
  }
  for (const [module, functions] of groups) {
    const json = JSON.stringify({ format: CODE_FORMAT, profile, module, functions });
    const scene = "bifoil_code_" + hash(json);
    modules[module] = hash("module:" + module);
    chunks[module] = { scene, module_digest: modules[module] };
    sources.set(scene, "*comment compiled fixture\n*bifoil_module " + json + "\n*return\n");
  }
  const manifest = { ...program, format: PACKAGE_FORMAT, profile, modules, functions: {}, chunks };
  if (lazy) {
    manifest.format = LAZY_PACKAGE_FORMAT;
    manifest.function_headers = Object.create(null);
    for (const [module, functions] of groups)
      for (const [id, fn] of Object.entries(functions)) manifest.function_headers[id] = summarizeFunction(fn, module);
  }
  const startup = "*bifoil " + JSON.stringify(manifest) + "\n";
  return { manifest, sources, startup };
}
