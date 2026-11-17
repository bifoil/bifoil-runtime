// Shared parsing and integrity checks for eager and lazy compiled packages.
import { BifoilError, check } from "./errors.mjs";
import { MAX_MODULES } from "./program-limits.mjs";
import { PROFILE, extendedProfileSupported } from "./compatibility.mjs";

export const PACKAGE_FORMAT = "bifoil.package.v1";
export const LAZY_PACKAGE_FORMAT = "bifoil.package.v2";
export const CODE_FORMAT = "bifoil.code.v1";
export { PROFILE };
const SCENE = /^bifoil_code_[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
export const record = (item) => item !== null && typeof item === "object" && !Array.isArray(item);

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
      extendedProfileSupported(chunk.profile) &&
      typeof chunk.module === "string" &&
      record(chunk.functions),
    "unsupported compiled code chunk",
  );
  return chunk;
}

export function packageReferences(manifest) {
  check(
    record(manifest) &&
      [PACKAGE_FORMAT, LAZY_PACKAGE_FORMAT].includes(manifest.format) &&
      extendedProfileSupported(manifest.profile) &&
      typeof manifest.build === "string" &&
      HASH.test(manifest.build) &&
      record(manifest.modules) &&
      record(manifest.chunks) &&
      record(manifest.functions) &&
      Object.keys(manifest.functions).length === 0,
    "invalid compiled package manifest",
  );
  const entries = Object.entries(manifest.chunks);
  check(
    entries.length > 0 && entries.length <= MAX_MODULES && Object.keys(manifest.modules).length === entries.length,
    "invalid package module inventory",
  );
  const scenes = new Set();
  for (const [module, reference] of entries) {
    check(
      record(reference) &&
        validCodeScene(reference.scene) &&
        !scenes.has(reference.scene) &&
        Object.hasOwn(manifest.modules, module) &&
        typeof reference.module_digest === "string" &&
        HASH.test(reference.module_digest) &&
        reference.module_digest === manifest.modules[module],
      "invalid package code reference",
    );
    scenes.add(reference.scene);
  }
  return entries;
}

export async function sha256(json) {
  check(globalThis.crypto?.subtle, "compiled packages require Web Crypto or a digest hook");
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readVerifiedChunk(module, reference, readChunk, digest, profile) {
  const { json, value } = commandPayload(await readChunk(reference.scene), "bifoil_module");
  const chunk = validateCodeChunk(value);
  check(chunk.profile === profile, "compiled code chunk belongs to a different instruction profile");
  check(chunk.module === module, "compiled code chunk belongs to a different module");
  const checksum = await digest(json);
  check(
    typeof checksum === "string" && HASH.test(checksum) && reference.scene === "bifoil_code_" + checksum,
    "compiled code chunk checksum mismatch: " + reference.scene,
  );
  return { chunk, bytes: new TextEncoder().encode(json).byteLength };
}
