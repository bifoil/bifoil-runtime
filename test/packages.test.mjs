import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VM } from "../src/vm.mjs";
import { loadCompiledProgram, loadPackage, commandPayload } from "../src/packages.mjs";
import { readCompiledProgram } from "../src/node-program.mjs";
import { installChoiceScript } from "../src/choicescript.mjs";
import { splitCompiledProgram } from "./support/packages.mjs";

const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
const packaged = () => splitCompiledProgram(fixture());

function sceneType() {
  class Scene {
    constructor(name = "startup", stats = {}) {
      this.name = name;
      this.stats = stats;
    }
  }
  Scene.validCommands = {};
  return Scene;
}
function stage(Scene, data, stats) {
  for (const [name, source] of data.sources) {
    const scene = new Scene(name, stats);
    scene.bifoil_module(commandPayload(source, "bifoil_module").json);
  }
}

test("compiled packages retain input snapshots and restore without replay", async () => {
  const data = packaged();
  const program = await loadCompiledProgram(data.startup, (name) => data.sources.get(name));
  const machine = new VM(program);
  assert.equal(machine.run().status, "waiting");
  const restored = VM.restore(await loadPackage(data.manifest, (name) => data.sources.get(name)), machine.save());
  assert.equal(restored.choose(0).status, "done");
  assert.deepEqual(restored.state.transcript, ["Result 12; counter 2; next 3; after 3."]);
});

test("filesystem package loading verifies companion code scenes", async () => {
  const data = packaged(),
    directory = mkdtempSync(join(tmpdir(), "bifoil-package-"));
  try {
    writeFileSync(join(directory, "startup.txt"), data.startup);
    for (const [name, source] of data.sources) writeFileSync(join(directory, name + ".txt"), source);
    const program = await readCompiledProgram(join(directory, "startup.txt"));
    assert.equal(program.format, "bifoil.program.v2");
    const [name, source] = data.sources.entries().next().value;
    writeFileSync(join(directory, name + ".txt"), source.replace("compiled fixture", "changed comment"));
    await readCompiledProgram(join(directory, "startup.txt"));
    writeFileSync(join(directory, name + ".txt"), source.replace('"span"', '"changed_span"'));
    await assert.rejects(readCompiledProgram(join(directory, "startup.txt")), /checksum/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("package references reject traversal, wrong module identities and corrupt code before execution", async () => {
  for (const mode of ["path", "identity", "missing", "profile", "checksum"]) {
    const data = packaged(),
      [module, reference] = Object.entries(data.manifest.chunks)[0];
    if (mode === "path") reference.scene = "../../other";
    if (mode === "identity") reference.module_digest = "0".repeat(64);
    if (mode === "profile") data.manifest.profile = "unknown";
    await assert.rejects(
      loadPackage(data.manifest, (name) => {
        if (mode === "missing") throw new Error("missing code scene");
        return mode === "checksum" ? data.sources.get(name).replace('"span"', '"wrong_span"') : data.sources.get(name);
      }),
      /invalid|unsupported|missing|checksum/,
    );
    assert.equal(typeof module, "string");
  }
});

test("ChoiceScript package registration restores in a fresh scene", async () => {
  const data = packaged(),
    Scene = sceneType(),
    stats = {},
    output = [];
  let choose;
  const adapter = installChoiceScript(Scene, {
    print: (_scene, text) => output.push(text),
    renderChoice: (_scene, _options, select) => {
      choose = select;
    },
  });
  stage(Scene, data, stats);
  const scene = new Scene("startup", stats);
  scene.bifoil(JSON.stringify(data.manifest));
  await scene.bifoilLoading;
  const saved = scene.stats.bifoil_checkpoint;
  adapter.detach(scene);
  const fresh = new Scene("startup", { bifoil_checkpoint: saved });
  const program = await loadPackage(data.manifest, (name) => data.sources.get(name));
  adapter.restore(fresh, program);
  choose(0);
  assert.deepEqual(output, ["Result 12; counter 2; next 3; after 3."]);
});

test("pending package loading cannot replace a detached or newer session", async () => {
  for (const replacement of ["detach", "inline", "reinstall"]) {
    const data = packaged(),
      Scene = sceneType(),
      stats = {},
      output = [];
    let release,
      released = false;
    const hooks = {
      print: (_scene, text) => output.push(text),
      renderChoice() {},
      digest: (json) =>
        released
          ? hash(json)
          : new Promise((resolve) => {
              release = () => resolve(hash(json));
            }),
    };
    const adapter = installChoiceScript(Scene, hooks);
    stage(Scene, data, stats);
    const scene = new Scene("startup", stats);
    scene.bifoil(JSON.stringify(data.manifest));
    const pending = scene.bifoilLoading;
    await new Promise(setImmediate);
    assert.equal(typeof release, "function");
    let current = null;
    if (replacement === "detach") adapter.detach(scene);
    else {
      const target =
        replacement === "reinstall" ? installChoiceScript(Scene, { print: hooks.print, renderChoice() {} }) : adapter;
      current = target.attach(scene, fixture());
      current.run();
    }
    released = true;
    release();
    assert.equal(await pending, null);
    assert.equal(scene.bifoilSession ?? null, current);
    assert.deepEqual(output, []);
    assert.equal(scene.bifoilLoading, undefined);
  }
});

test("package checksum failures stop before any story preparation", async () => {
  const data = packaged(),
    Scene = sceneType(),
    stats = {},
    output = [];
  installChoiceScript(Scene, { print: (_scene, text) => output.push(text), digest: () => "0".repeat(64) });
  stage(Scene, data, stats);
  const scene = new Scene("startup", stats);
  scene.bifoil(JSON.stringify(data.manifest));
  const pending = scene.bifoilLoading;
  await assert.rejects(pending, /checksum/);
  assert.equal(scene.finished, true);
  assert.equal(scene.bifoilSession, undefined);
  assert.match(scene.bifoilFailure.message, /checksum/);
  assert.equal(output.length, 1);
  assert.match(output[0], /checksum/);
});

test("filesystem scene reads reject oversized input and preserve split UTF-8 scalars", async () => {
  const data = packaged();
  const directory = mkdtempSync(join(tmpdir(), "bifoil-package-input-"));
  const root = join(directory, "startup.txt");
  try {
    writeFileSync(root, "");
    truncateSync(root, 16 * 1024 * 1024 + 1);
    await assert.rejects(readCompiledProgram(root), /scene size budget/);
    // The emoji's first UTF-8 byte is the final byte of a 64 KiB read.
    const comment = "*comment " + "x".repeat(65535 - 9) + "😀\n";
    writeFileSync(root, comment + data.startup);
    for (const [name, source] of data.sources) writeFileSync(join(directory, name + ".txt"), source);
    const program = await readCompiledProgram(root);
    assert.equal(new VM(program).run().status, "waiting");
    const [name] = data.sources.keys();
    const chunk = join(directory, name + ".txt");
    truncateSync(chunk, 16 * 1024 * 1024 + 1);
    await assert.rejects(readCompiledProgram(root), /scene size budget/);
    // Invalid UTF-8 in ignored comments must not be silently replaced.
    writeFileSync(root, Buffer.concat([Buffer.from("*comment "), Buffer.from([0xed, 0xa0, 0x80])]));
    await assert.rejects(readCompiledProgram(root), /encoded data|encoding/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
