// Versioned compiled packages: eager compatibility and verified on-demand bodies.
import { check } from "./errors.mjs";
import { validateProgram } from "./program.mjs";
import { MAX_FUNCTIONS, MAX_INSTRUCTIONS, MAX_MODULE_INSTRUCTIONS, MAX_MODULE_FUNCTIONS } from "./program-limits.mjs";

import { loadLazyPackage } from "./lazy-packages.mjs";
import {
  PACKAGE_FORMAT,
  LAZY_PACKAGE_FORMAT,
  commandPayload,
  packageReferences,
  readVerifiedChunk,
  sha256,
  record,
} from "./package-format.mjs";
export {
  PACKAGE_FORMAT,
  LAZY_PACKAGE_FORMAT,
  CODE_FORMAT,
  commandPayload,
  validCodeScene,
  validateCodeChunk,
} from "./package-format.mjs";

export async function loadPackage(manifest, readChunk, options = {}) {
  const { digest = sha256 } = options;
  if (manifest?.format === LAZY_PACKAGE_FORMAT) return loadLazyPackage(manifest, readChunk, { ...options, digest });
  const entries = packageReferences(manifest);
  check(typeof readChunk === "function" && typeof digest === "function", "compiled package loader required");
  const functions = Object.create(null);
  let count = 0,
    instructions = 0;
  // Sequential loading avoids keeping every encoded chunk alongside its decoded code.
  for (const [module, reference] of entries) {
    const { chunk } = await readVerifiedChunk(module, reference, readChunk, digest, manifest.profile);
    let moduleInstructions = 0,
      moduleFunctions = 0;
    for (const [id, fn] of Object.entries(chunk.functions)) {
      check(
        id.startsWith(module + ".") &&
          !Object.hasOwn(functions, id) &&
          record(fn) &&
          fn.signature?.id === id &&
          Array.isArray(fn.code),
        "invalid or duplicate package function",
      );
      moduleFunctions++;
      check(moduleFunctions <= MAX_MODULE_FUNCTIONS, "compiled module function budget exceeded");
      count++;
      moduleInstructions += fn.code.length;
      check(moduleInstructions <= MAX_MODULE_INSTRUCTIONS, "compiled module code budget exceeded");
      instructions += fn.code.length;
      check(count <= MAX_FUNCTIONS && instructions <= MAX_INSTRUCTIONS, "compiled package code budget exceeded");
      Object.defineProperty(functions, id, { value: fn, enumerable: true });
    }
  }
  const { chunks, format, functions: empty, ...program } = manifest;
  return validateProgram({ ...program, format: "bifoil.program.v2", functions });
}

export async function loadCompiledProgram(source, readChunk, options) {
  const { value } = commandPayload(source, "bifoil");
  return [PACKAGE_FORMAT, LAZY_PACKAGE_FORMAT].includes(value?.format)
    ? loadPackage(value, readChunk, options)
    : validateProgram(value);
}
