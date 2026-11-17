// Versioned on-demand code loading. Declarations stay resident; bodies use an
// LRU with explicit limits. A VM retains only its current function's body across
// host yields, so evicting callers never loses their PCs or partial operands.
import { check } from "./errors.mjs";
import { validateProgram, validateFunctionBody } from "./program.mjs";
import { registerProgramCode } from "./program-code.mjs";
import { validateCodeMetadata, summarizeFunction, sameMetadata } from "./code-metadata.mjs";
import { packageReferences, readVerifiedChunk, sha256, record } from "./package-format.mjs";
import { MAX_FUNCTIONS, MAX_INSTRUCTIONS, MAX_MODULE_FUNCTIONS, MAX_MODULE_INSTRUCTIONS } from "./program-limits.mjs";

export function loadLazyPackage(
  manifest,
  readChunk,
  { digest = sha256, maxResidentModules = 4, maxResidentBytes = 32 * 1024 * 1024 } = {},
) {
  const references = new Map(packageReferences(manifest));
  check(typeof readChunk === "function" && typeof digest === "function", "compiled package loader required");
  check(
    Number.isSafeInteger(maxResidentModules) &&
      maxResidentModules > 0 &&
      Number.isSafeInteger(maxResidentBytes) &&
      maxResidentBytes > 0,
    "invalid resident-code budget",
  );
  check(record(manifest.function_headers), "missing lazy function headers");
  const ids = Object.keys(manifest.function_headers);
  check(ids.length > 0 && ids.length <= MAX_FUNCTIONS, "function budget exceeded");
  const groups = new Map([...references.keys()].map((module) => [module, new Set()]));
  const totals = new Map([...references.keys()].map((module) => [module, 0]));
  let instructions = 0;
  for (const id of ids) {
    const header = manifest.function_headers[id];
    validateCodeMetadata(header, manifest.function_headers);
    check(groups.has(header.module) && id.startsWith(header.module + "."), "invalid lazy function ownership");
    groups.get(header.module).add(id);
    const total = totals.get(header.module) + header.instructions;
    totals.set(header.module, total);
    instructions += header.instructions;
    check(
      groups.get(header.module).size <= MAX_MODULE_FUNCTIONS && total <= MAX_MODULE_INSTRUCTIONS,
      "compiled module code budget exceeded",
    );
    check(instructions <= MAX_INSTRUCTIONS, "compiled package code budget exceeded");
  }
  freezeData(manifest);
  const { chunks, function_headers: headers, format, functions: empty, ...metadata } = manifest;
  const provider = new CodeCache(headers, references, groups, readChunk, digest, maxResidentModules, maxResidentBytes);
  const functions = Object.create(null);
  for (const id of ids) {
    const header = headers[id];
    const declaration = { signature: header.signature, init: header.init, local: header.local };
    Object.defineProperty(declaration, "code", { get: () => provider.peek(id)?.code });
    Object.defineProperty(functions, id, { value: Object.freeze(declaration), enumerable: true });
  }
  const program = { ...metadata, format: "bifoil.program.v2", functions: Object.freeze(functions) };
  provider.program = program;
  registerProgramCode(program, provider);
  validateProgram(program);
  return Object.freeze(program);
}

class CodeCache {
  constructor(headers, references, groups, readChunk, digest, maxModules, maxBytes) {
    Object.assign(this, { headers, references, groups, readChunk, digest, maxModules, maxBytes });
    this.loaded = new Map();
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.bytes = 0;
    this.loads = 0;
    this.evictions = 0;
  }
  peek(id) {
    return this.touch(this.headers[id].module)?.functions[id];
  }
  touch(module) {
    const loaded = this.loaded.get(module);
    if (loaded) {
      this.loaded.delete(module);
      this.loaded.set(module, loaded);
    }
    return loaded;
  }
  loadFunction(id) {
    check(Object.hasOwn(this.headers, id), "unknown lazy function");
    const module = this.headers[id].module;
    const ready = this.touch(module);
    if (ready) return Promise.resolve(ready.functions[id].code);
    let pending = this.pending.get(module);
    if (!pending) {
      // Queue whole reads, including decoding and digest work, rather than
      // retaining several encoded modules while waiting for their validation.
      pending = this.queue.then(() => this.loadModule(module));
      this.pending.set(module, pending);
      this.queue = pending.then(
        () => undefined,
        () => undefined,
      );
      pending.then(
        () => this.pending.delete(module),
        () => this.pending.delete(module),
      );
    }
    return pending.then((entry) => entry.functions[id].code);
  }
  async loadModule(module) {
    const existing = this.touch(module);
    if (existing) return existing;
    const { chunk, bytes } = await readVerifiedChunk(
      module,
      this.references.get(module),
      this.readChunk,
      this.digest,
      this.program.profile,
    );
    check(bytes <= this.maxBytes, "compiled module exceeds resident-code budget");
    const ids = Object.keys(chunk.functions),
      expected = this.groups.get(module);
    check(ids.length === expected.size && ids.every((id) => expected.has(id)), "package function inventory mismatch");
    for (const id of ids) {
      const fn = chunk.functions[id];
      check(record(fn) && Array.isArray(fn.code), "invalid package function");
      check(
        sameMetadata(summarizeFunction(fn, module), this.headers[id]),
        "compiled function metadata mismatch: " + id,
      );
      validateFunctionBody(this.program, fn);
    }
    while (this.loaded.size && (this.loaded.size >= this.maxModules || this.bytes + bytes > this.maxBytes)) {
      const oldest = this.loaded.keys().next().value;
      this.bytes -= this.loaded.get(oldest).bytes;
      this.loaded.delete(oldest);
      this.evictions++;
    }
    freezeData(chunk);
    const entry = { functions: chunk.functions, bytes };
    this.loaded.set(module, entry);
    this.bytes += bytes;
    this.loads++;
    return entry;
  }
  stats() {
    return {
      residentModules: this.loaded.size,
      residentBytes: this.bytes,
      loads: this.loads,
      evictions: this.evictions,
      pendingModules: this.pending.size,
    };
  }
}

function freezeData(root) {
  const pending = [root],
    visited = new Set();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || visited.has(item)) continue;
    visited.add(item);
    for (const value of Object.values(item)) pending.push(value);
    Object.freeze(item);
  }
}
