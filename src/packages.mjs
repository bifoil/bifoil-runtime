// Read-only compiled code packages. Loading completes before any story code runs.
import { BifoilError, check } from "./errors.mjs";
import { PROFILE, validateProgram } from "./program.mjs";
import {
  MAX_FUNCTIONS,
  MAX_INSTRUCTIONS,
  MAX_MODULE_INSTRUCTIONS,
  MAX_MODULE_FUNCTIONS,
  MAX_MODULES,
} from "./program-limits.mjs";

export const PACKAGE_FORMAT = "bifoil.package.v1";
export const CODE_FORMAT = "bifoil.code.v1";
const SCENE = /^bifoil_code_[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const record = (item) => item !== null && typeof item === "object" && !Array.isArray(item);

export function commandPayload(source, command) {
  check(typeof source === "string" && source.length <= 16 * 1024 * 1024, "compiled scene size budget exceeded");
  const prefix = "*" + command + " ";
  const lines = source.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  check(lines.length === 1, "compiled scene requires one *" + command + " command");
  const json = lines[0].slice(prefix.length);
  try {
    return { json, value: JSON.parse(json) };
  } catch {
    throw new BifoilError("invalid compiled " + command + " JSON");
  }
}

export function validCodeScene(name) {
  return typeof name === "string" && SCENE.test(name);
}

export function validateCodeChunk(chunk) {
  check(
    record(chunk) &&
      chunk.format === CODE_FORMAT &&
      chunk.profile === PROFILE &&
      typeof chunk.module === "string" &&
      record(chunk.functions),
    "unsupported compiled code chunk",
  );
  return chunk;
}

async function sha256(json) {
  check(globalThis.crypto?.subtle, "compiled packages require Web Crypto or a digest hook");
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadPackage(manifest, readChunk, { digest = sha256 } = {}) {
  check(
    record(manifest) &&
      manifest.format === PACKAGE_FORMAT &&
      manifest.profile === PROFILE &&
      typeof manifest.build === "string" &&
      HASH.test(manifest.build) &&
      record(manifest.modules) &&
      record(manifest.chunks) &&
      record(manifest.functions) &&
      Object.keys(manifest.functions).length === 0,
    "invalid compiled package manifest",
  );
  const modules = Object.keys(manifest.modules),
    entries = Object.entries(manifest.chunks);
  check(
    entries.length > 0 && entries.length <= MAX_MODULES && modules.length === entries.length,
    "invalid package module inventory",
  );
  check(typeof readChunk === "function" && typeof digest === "function", "compiled package loader required");
  const functions = Object.create(null),
    scenes = new Set();
  let count = 0,
    instructions = 0;
  // Sequential loading avoids keeping every encoded chunk alongside its decoded code.
  for (const [module, reference] of entries) {
    check(
      record(reference) &&
        validCodeScene(reference.scene) &&
        !scenes.has(reference.scene) &&
        Object.hasOwn(manifest.modules, module) &&
        HASH.test(reference.module_digest) &&
        reference.module_digest === manifest.modules[module],
      "invalid package code reference",
    );
    scenes.add(reference.scene);
    const { json, value } = commandPayload(await readChunk(reference.scene), "bifoil_module");
    const chunk = validateCodeChunk(value);
    check(chunk.module === module, "compiled code chunk belongs to a different module");
    const checksum = await digest(json);
    check(
      typeof checksum === "string" && HASH.test(checksum) && reference.scene === "bifoil_code_" + checksum,
      "compiled code chunk checksum mismatch: " + reference.scene,
    );
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
  return value?.format === PACKAGE_FORMAT ? loadPackage(value, readChunk, options) : validateProgram(value);
}
