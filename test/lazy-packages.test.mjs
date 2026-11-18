import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCompiledProgram } from "../src/node-program.mjs";
import { createHash } from "node:crypto";
import { VM } from "../src/vm.mjs";
import { loadPackage, loadCompiledProgram } from "../src/packages.mjs";
import { packageCodeStats, programCode } from "../src/program-code.mjs";
import { loadLazyPackage } from "../src/lazy-packages.mjs";
import { readBrowserCode } from "../src/browser-code.mjs";
import { installChoiceScript } from "../src/choicescript.mjs";
import { splitCompiledProgram } from "./support/packages.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
const expected = ["Result 12; counter 2; next 3; after 3."];

function packaged({ marks = false, late = false } = {}) {
  const program = fixture();
  if (marks) {
    const code = program.functions[program.entry].code;
    for (const instruction of code) {
      if (typeof instruction.target === "number") instruction.target++;
      if (typeof instruction.fallback === "number") instruction.fallback++;
    }
    code.unshift({ op: "stack_mark", id: 7, span: { file: "src/main.bfl", line: 1 } });
  }
  program.functions["unused.never"] = {
    signature: { id: "unused.never", params: [], result: { kind: "unit" }, suspend: false, scene: false },
    init: false,
    local: false,
    code: [
      { op: "constant", ty: { kind: "unit" }, value: null, span: { file: "src/unused.bfl", line: 1 } },
      { op: "return", span: { file: "src/unused.bfl", line: 1 } },
    ],
  };
  if (late) {
    const fn = structuredClone(program.functions["unused.never"]);
    fn.signature.id = "late.step";
    program.functions["late.step"] = fn;
    const body = program.functions["main.start$ask@9"].code;
    for (const instruction of body) {
      if (typeof instruction.target === "number" && instruction.target >= 26) instruction.target += 3;
      if (typeof instruction.fallback === "number" && instruction.fallback >= 26) instruction.fallback += 3;
    }
    const span = { file: "src/main.bfl", line: 10 };
    body.splice(
      26,
      0,
      { op: "load", name: "late.step", span },
      { op: "call", names: [], direct: true, span },
      { op: "pop", span },
    );
  }
  return splitCompiledProgram(program, { lazy: true });
}

async function finishLoading(machine, result) {
  const output = [];
  while (result.status === "loading") {
    output.push(...result.output);
    await result.ready;
    result = machine.run();
  }
  output.push(...result.output);
  return { ...result, output };
}

test("direct lazy loading uses its defaults, coalesces VM polling and reuses resident code", async () => {
  const data = packaged();
  const reads = [];
  const program = loadLazyPackage(data.manifest, async (name) => {
    reads.push(name);
    return data.sources.get(name);
  });
  const machine = new VM(program);
  const first = machine.run();
  assert.equal(first.status, "loading");
  const polled = machine.run();
  assert.equal(polled.status, "loading");
  assert.equal(polled.ready, first.ready);
  await first.ready;
  const provider = programCode(program);
  const code = await provider.loadFunction(program.entry);
  assert.equal(code, program.functions[program.entry].code);
  assert.equal(await provider.loadFunction(program.entry), code);
  const resident = await provider.loadModule(provider.headers[program.entry].module);
  assert.equal(resident.functions[program.entry].code, code);
  assert.equal(reads.length, 1);
  const waiting = await finishLoading(machine, machine.run());
  assert.equal(waiting.status, "waiting");
  const final = await finishLoading(machine, machine.choose(0));
  assert.deepEqual(final.output, expected);
});

test("lazy roots validate declarations without reading unused or active bodies", async () => {
  const data = packaged(),
    reads = [];
  const program = await loadCompiledProgram(data.startup, (name) => {
    reads.push(name);
    assert.notEqual(name, data.manifest.chunks.unused.scene);
    return data.sources.get(name);
  });
  assert.deepEqual(reads, []);
  assert.equal(program.functions[program.entry].code, undefined);
  const machine = new VM(program);
  const loading = machine.run();
  assert.equal(loading.status, "loading");
  assert.equal(machine.state.pending, null);
  assert.throws(() => machine.save(), /prepared input checkpoint/);
  assert.equal((await finishLoading(machine, loading)).status, "waiting");
  assert.equal(reads.length, 2);
  assert.equal(packageCodeStats(program).residentModules, 2);
});

test("one-module residency evicts nested callers and resumes operands without replay", async () => {
  const data = packaged(),
    reads = [];
  const program = await loadPackage(
    data.manifest,
    (name) => {
      reads.push(name);
      return data.sources.get(name);
    },
    { maxResidentModules: 1 },
  );
  const machine = new VM(program);
  assert.equal((await machine.runAsync()).status, "waiting");
  assert.equal((await finishLoading(machine, machine.choose(0))).status, "done");
  assert.deepEqual(machine.state.transcript, expected);
  assert.ok(packageCodeStats(program).evictions >= 2);
  assert.equal(packageCodeStats(program).residentModules, 1);
  assert.ok(reads.filter((name) => name === data.manifest.chunks.main.scene).length >= 2);
  assert.equal(reads.includes(data.manifest.chunks.unused.scene), false);
});

test("fresh-host restore checks captured values, loop marks and choices without code reads", async () => {
  const original = packaged({ marks: true });
  const program = await loadPackage(original.manifest, (name) => original.sources.get(name), { maxResidentModules: 1 });
  const first = new VM(program);
  await first.runAsync();
  const checkpoint = first.save(),
    data = packaged({ marks: true }),
    reads = [];
  const fresh = await loadPackage(
    data.manifest,
    (name) => {
      reads.push(name);
      return data.sources.get(name);
    },
    { maxResidentModules: 1 },
  );
  const restored = VM.restore(fresh, checkpoint);
  assert.deepEqual(reads, []);
  const invalid = JSON.parse(checkpoint);
  invalid.frames[0].loopMarks[0].id = 999;
  assert.throws(() => VM.restore(fresh, JSON.stringify(invalid)), /loop stack mark/);
  assert.deepEqual(reads, []);
  assert.equal((await finishLoading(restored, restored.choose(0))).status, "done");
  assert.deepEqual(restored.state.transcript, expected);
});

test("corrupt unvisited modules are deferred and fail permanently when first invoked", async () => {
  const data = packaged({ late: true });
  const helper = data.manifest.chunks.late.scene;
  data.sources.set(helper, data.sources.get(helper).replace('"span"', '"changed_span"'));
  const reads = [],
    program = await loadPackage(
      data.manifest,
      (name) => {
        reads.push(name);
        return data.sources.get(name);
      },
      { maxResidentModules: 1 },
    );
  const machine = new VM(program);
  assert.equal((await machine.runAsync()).status, "waiting");
  assert.equal(reads.includes(helper), false);
  await assert.rejects(finishLoading(machine, machine.choose(0)), /checksum mismatch/);
  const failure = machine.failure,
    count = reads.length;
  assert.equal(machine.state.failed, true);
  assert.throws(
    () => machine.run(),
    (error) => error === failure,
  );
  assert.throws(
    () => machine.save(),
    (error) => error === failure,
  );
  assert.equal(reads.length, count);
});

test("every fetched module must match its root signature, captures and continuation inventory", async () => {
  for (const mode of ["count", "capture", "continuation", "signature", "inventory"]) {
    const data = packaged(),
      header = data.manifest.function_headers["main.start"];
    if (mode === "count") header.instructions++;
    if (mode === "capture") header.captures = [];
    if (mode === "continuation")
      header.continuations[0] = { op: "stack_mark", id: 999, span: { file: "src/main.bfl", line: 1 } };
    if (mode === "signature") header.signature.result = { kind: "int" };
    if (mode === "inventory") {
      const extra = structuredClone(header);
      extra.signature.id = "main.extra";
      extra.captures = [];
      extra.continuations = {};
      data.manifest.function_headers["main.extra"] = extra;
    }
    const program = await loadPackage(data.manifest, (name) => data.sources.get(name));
    const machine = new VM(program);
    await assert.rejects(machine.runAsync(), /metadata mismatch|inventory mismatch/);
    assert.deepEqual(machine.state.transcript, []);
  }
});

test("invalid root metadata and budgets reject before reading a chunk", async () => {
  for (const mode of ["owner", "position", "captures", "jump", "budget", "parameters"]) {
    const data = packaged(),
      header = data.manifest.function_headers["main.start"];
    if (mode === "owner") header.module = "missing";
    if (mode === "position") header.continuations.bad = { op: "choose", fallback: null };
    if (mode === "captures") header.captures[0].captures = ["duplicate", "duplicate"];
    if (mode === "jump")
      header.continuations[0] = { op: "choose", fallback: 1000000, span: { file: "src/main.bfl", line: 1 } };
    if (mode === "budget") header.instructions = 500001;
    if (mode === "parameters") header.signature.params = [{ name: "bad" }];
    let reads = 0;
    await assert.rejects(
      loadPackage(data.manifest, () => {
        reads++;
      }),
      /invalid|budget/,
    );
    assert.equal(reads, 0);
  }
  const data = packaged();
  await assert.rejects(
    loadPackage(data.manifest, () => "", { maxResidentModules: 0 }),
    /resident-code budget/,
  );
  const tiny = await loadPackage(packaged().manifest, (name) => data.sources.get(name), { maxResidentBytes: 1 });
  await assert.rejects(new VM(tiny).runAsync(), /resident-code budget/);
});

test("simultaneous machines coalesce a module fetch while retaining independent story state", async () => {
  const data = packaged();
  let release,
    reads = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const program = await loadPackage(
    data.manifest,
    async (name) => {
      reads++;
      await gate;
      return data.sources.get(name);
    },
    { maxResidentModules: 1 },
  );
  const first = new VM(program),
    second = new VM(program);
  const one = first.runAsync(),
    two = second.runAsync();
  await new Promise(setImmediate);
  assert.equal(reads, 1);
  release();
  assert.equal((await one).status, "waiting");
  assert.equal((await two).status, "waiting");
  assert.notEqual(first.state, second.state);
  await Promise.all([finishLoading(first, first.choose(0)), finishLoading(second, second.choose(0))]);
  assert.deepEqual(first.state.transcript, expected);
  assert.deepEqual(second.state.transcript, expected);
});

function sceneType() {
  class Scene {
    constructor(stats = {}) {
      this.name = "startup";
      this.stats = stats;
    }
  }
  Scene.validCommands = {};
  return Scene;
}

test("detaching or replacing a session during a code fetch cannot resume its old story", async () => {
  for (const replacement of ["detach", "replace"]) {
    const data = packaged(),
      Scene = sceneType(),
      scene = new Scene(),
      output = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const adapter = installChoiceScript(Scene, {
      digest: hash,
      readChunk: async (_scene, name) => {
        await gate;
        return data.sources.get(name);
      },
      print: (_scene, text) => output.push(text),
      renderChoice() {
        throw new Error("obsolete input");
      },
    });
    scene.bifoil(JSON.stringify(data.manifest));
    const pending = scene.bifoilLoading;
    await new Promise(setImmediate);
    let current;
    if (replacement === "detach") adapter.detach(scene);
    else current = adapter.attach(scene, fixture());
    release();
    assert.equal(await pending, null);
    assert.equal(scene.bifoilSession, current);
    assert.deepEqual(output, []);
    assert.equal(scene.bifoilFailure, undefined);
  }
});

test("the adapter surfaces a late code failure once and keeps completed preparation", async () => {
  const data = packaged({ late: true }),
    Scene = sceneType(),
    scene = new Scene(),
    output = [],
    failures = [];
  let choose;
  installChoiceScript(Scene, {
    digest: hash,
    readChunk: (_scene, name) => (name === data.manifest.chunks.late.scene ? "bad" : data.sources.get(name)),
    print: (_scene, text) => output.push(text),
    error: (_scene, error) => failures.push(error),
    renderChoice: (_scene, _options, select) => {
      choose = select;
    },
  });
  scene.bifoil(JSON.stringify(data.manifest));
  await scene.bifoilLoading;
  assert.equal(typeof choose, "function");
  assert.equal(typeof scene.stats.bifoil_checkpoint, "string");
  choose(0);
  await assert.rejects(scene.bifoilLoading, /compiled scene requires/);
  await new Promise(setImmediate);
  assert.equal(failures.length, 1);
  assert.equal(scene.bifoilFailure, failures[0]);
  assert.equal(scene.bifoilSession.machine.failure, failures[0]);
  assert.equal(scene.stats.bifoil_checkpoint, undefined);
  assert.deepEqual(output, []);
});

test("browser code reads stream UTF-8, enforce byte budgets and cancel rejected streams", async () => {
  const previous = globalThis.fetch;
  const name = "bifoil_code_" + "a".repeat(64),
    requests = [];
  try {
    globalThis.fetch = async (url) => {
      requests.push(url);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Uint8Array.of(0xf0, 0x9f));
            controller.enqueue(Uint8Array.of(0x98, 0x80));
            controller.close();
          },
        }),
      );
    };
    assert.equal(await readBrowserCode({ baseUrl: "/scenes/" }, name), "😀");
    assert.deepEqual(requests, ["/scenes/" + name + ".txt"]);
    await assert.rejects(readBrowserCode({}, "../other"), /invalid compiled code scene/);
    assert.equal(requests.length, 1);
    let canceled = 0;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            canceled++;
          },
        }),
        { headers: { "content-length": "16777217" } },
      );
    await assert.rejects(readBrowserCode({}, name), /size budget/);
    assert.equal(canceled, 1);
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
          },
          cancel() {
            canceled++;
          },
        }),
      );
    await assert.rejects(readBrowserCode({}, name), /size budget/);
    assert.equal(canceled, 2);
    globalThis.fetch = async () => new Response(Uint8Array.of(0xed, 0xa0, 0x80));
    await assert.rejects(readBrowserCode({}, name), /encoded data|encoding/i);
  } finally {
    globalThis.fetch = previous;
  }
});

test("evicted bodies are fetched and verified again before a caller resumes", async () => {
  const data = packaged(),
    main = data.manifest.chunks.main.scene;
  let mainReads = 0;
  const program = await loadPackage(
    data.manifest,
    (name) => {
      const source = data.sources.get(name);
      return name === main && ++mainReads > 1 ? source.replace('"span"', '"wrong_span"') : source;
    },
    { maxResidentModules: 1 },
  );
  const machine = new VM(program);
  await assert.rejects(machine.runAsync(), /checksum/);
  assert.equal(mainReads, 2);
  assert.equal(packageCodeStats(program).residentModules, 1);
  assert.deepEqual(machine.state.transcript, []);
});

test("lazy declarations retain host-property-like module and function names", async () => {
  const original = fixture();
  const declaration = original.functions[original.entry];
  original.functions = Object.create(null);
  original.entry = "__proto__.constructor";
  original.functions[original.entry] = {
    signature: { ...declaration.signature, id: original.entry },
    init: false,
    local: false,
    code: [
      { op: "constant", ty: { kind: "unit" }, value: null, span: { file: "src/names.bfl", line: 1 } },
      { op: "return", span: { file: "src/names.bfl", line: 1 } },
    ],
  };
  const data = splitCompiledProgram(original, { lazy: true });
  const program = await loadPackage(data.manifest, (name) => data.sources.get(name));
  assert.equal(Object.getPrototypeOf(program.functions), null);
  assert.equal((await new VM(program).runAsync()).status, "done");
});

test("a broad module inventory does not make unvisited instruction bodies resident", async () => {
  const original = fixture();
  for (let index = 0; index < 300; index++) {
    const id = "cold" + index + ".unused";
    original.functions[id] = {
      signature: { id, params: [], result: { kind: "unit" }, suspend: false, scene: false },
      init: false,
      local: false,
      code: [
        { op: "constant", ty: { kind: "unit" }, value: null, span: { file: "src/cold.bfl", line: 1 } },
        { op: "return", span: { file: "src/cold.bfl", line: 1 } },
      ],
    };
  }
  const data = splitCompiledProgram(original, { lazy: true }),
    reads = [];
  const program = await loadPackage(
    data.manifest,
    (name) => {
      reads.push(name);
      return data.sources.get(name);
    },
    { maxResidentModules: 1 },
  );
  const machine = new VM(program);
  await machine.runAsync();
  await finishLoading(machine, machine.choose(0));
  assert.deepEqual(machine.state.transcript, expected);
  assert.equal(new Set(reads).size, 2);
  assert.equal(packageCodeStats(program).residentModules, 1);
  for (let index = 0; index < 300; index++) assert.equal(program.functions["cold" + index + ".unused"].code, undefined);
  assert.equal(machine.activeCode, null);
});

test("filesystem lazy reads defer oversized unopened code and reject it before decoding on demand", async () => {
  const data = packaged({ late: true }),
    directory = mkdtempSync(join(tmpdir(), "bifoil-lazy-code-"));
  try {
    const root = join(directory, "startup.txt");
    writeFileSync(root, data.startup);
    for (const [name, source] of data.sources) writeFileSync(join(directory, name + ".txt"), source);
    truncateSync(join(directory, data.manifest.chunks.late.scene + ".txt"), 16 * 1024 * 1024 + 1);
    const program = await readCompiledProgram(root, { maxResidentModules: 1 });
    const machine = new VM(program);
    assert.equal((await machine.runAsync()).status, "waiting");
    await assert.rejects(finishLoading(machine, machine.choose(0)), /scene size budget/);
    assert.equal(packageCodeStats(program).residentModules, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("asynchronous execution keeps completed output drainable once after a later fetch failure", async () => {
  const original = fixture(),
    span = { file: "src/main.bfl", line: 1 };
  const body = original.functions[original.entry].code;
  for (const instruction of body) {
    if (typeof instruction.target === "number") instruction.target += 2;
    if (typeof instruction.fallback === "number") instruction.fallback += 2;
  }
  body.unshift({ op: "constant", ty: { kind: "string" }, value: "Before load", span }, { op: "print", span });
  const data = splitCompiledProgram(original, { lazy: true });
  const program = await loadPackage(data.manifest, (name) =>
    name === data.manifest.chunks.helpers.scene ? "bad" : data.sources.get(name),
  );
  const machine = new VM(program);
  await assert.rejects(machine.runAsync(), /compiled scene requires/);
  assert.deepEqual(machine.state.transcript, ["Before load"]);
  assert.deepEqual(machine.drainOutput(), ["Before load"]);
  assert.deepEqual(machine.drainOutput(), []);
});

test("browser reader cleanup cannot replace status and byte-budget diagnostics", async () => {
  const previous = globalThis.fetch,
    name = "bifoil_code_" + "a".repeat(64);
  let canceled = 0;
  try {
    const body = () =>
      new ReadableStream({
        cancel() {
          canceled++;
          throw new Error("cleanup failed");
        },
      });
    globalThis.fetch = async () => new Response(body(), { status: 503 });
    await assert.rejects(readBrowserCode({}, name), /cannot load compiled code scene/);
    globalThis.fetch = async () => new Response(body(), { headers: { "content-length": "16777217" } });
    await assert.rejects(readBrowserCode({}, name), /scene size budget/);
    assert.equal(canceled, 2);
  } finally {
    globalThis.fetch = previous;
  }
});

test("eager compatibility cannot reinterpret malformed function flags as declarations", async () => {
  for (const flag of ["init", "local"]) {
    const original = fixture();
    original.functions[original.entry][flag] = "truthy";
    const data = splitCompiledProgram(original);
    await assert.rejects(
      loadPackage(data.manifest, (name) => data.sources.get(name)),
      /invalid function flags/,
    );
  }
});

test("a package keeps its original asset origin when the host changes Scene.baseUrl", async () => {
  const previous = globalThis.fetch,
    data = packaged(),
    Scene = sceneType(),
    scene = new Scene(),
    requests = [];
  Scene.baseUrl = "/original-assets";
  try {
    globalThis.fetch = async (url) => {
      requests.push(url);
      const name = url.slice(url.lastIndexOf("/") + 1, -4);
      return new Response(data.sources.get(name));
    };
    installChoiceScript(Scene, { digest: hash, maxResidentModules: 1, renderChoice() {} });
    scene.bifoil(JSON.stringify(data.manifest));
    Scene.baseUrl = "/other-story";
    await scene.bifoilLoading;
    assert.equal(scene.bifoilSession.machine.state.pending.options.length, 1);
    assert.ok(requests.length >= 3);
    assert.ok(requests.every((url) => url.startsWith("/original-assets/")));
  } finally {
    globalThis.fetch = previous;
  }
});
