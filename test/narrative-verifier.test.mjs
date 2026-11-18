import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyNarrativeCapacity } from "../tools/verify-narrative-capacity.mjs";
import { splitCompiledProgram } from "./support/packages.mjs";
import { readCompiledProgram } from "../src/node-program.mjs";
import { VM } from "../src/vm.mjs";

function addLongSetup(value) {
  const id = "main.verify_setup",
    span = { file: "src/setup.bfl", line: 1 },
    int = { kind: "int" };
  value.functions[id] = {
    signature: { id, params: [], result: { kind: "unit" }, suspend: false, scene: false },
    init: false,
    local: false,
    code: [
      { op: "constant", ty: int, value: 0 },
      { op: "declare", name: "verifier_setup_count", ty: int, mutable: true },
      { op: "load", name: "verifier_setup_count" },
      { op: "constant", ty: int, value: 1 },
      { op: "binary", operator: "+" },
      { op: "store", name: "verifier_setup_count" },
      { op: "load", name: "verifier_setup_count" },
      { op: "constant", ty: int, value: 200001 },
      { op: "binary", operator: "<" },
      { op: "jump_true", target: 2 },
      { op: "constant", ty: { kind: "unit" }, value: null },
      { op: "return" },
    ].map((instruction) => ({ ...instruction, span })),
  };
  const entry = value.functions[value.entry];
  for (const instruction of entry.code) {
    if (typeof instruction.target === "number") instruction.target += 3;
    if (typeof instruction.fallback === "number") instruction.fallback += 3;
  }
  entry.code.unshift(
    { op: "load", name: id, span },
    { op: "call", names: [], direct: true, span },
    { op: "pop", span },
  );
  value.build = "c".repeat(64);
}

function program(t, name, edited = false, longInitialization = false) {
  const value = JSON.parse(
    readFileSync(new URL(`./fixtures/narrative-capacity/${name}/program.json`, import.meta.url), "utf8"),
  );
  if (edited) {
    for (const operation of value.functions["rooms.r0000.enter"].code)
      if (operation.op === "constant" && operation.ty.kind === "string")
        operation.value = operation.value.replace("end0000", "End0000");
    value.build = "a".repeat(64);
  }
  if (longInitialization) addLongSetup(value);
  const package_ = splitCompiledProgram(value, { lazy: true });
  const directory = mkdtempSync(join(tmpdir(), "bifoil-narrative-verifier-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const startup = join(directory, "startup.txt");
  writeFileSync(startup, package_.startup);
  for (const [name, source] of package_.sources) writeFileSync(join(directory, name + ".txt"), source);
  return startup;
}

test("narrative verifier checks real flat and grouped packages across every restored wait", async (t) => {
  for (const name of ["flat", "grouped"])
    for (const edited of [false, true]) {
      const config = { scenes: 1, rows: 2, rooms: [0], edited_room: edited ? 0 : null };
      if (name === "grouped") config.routing_group_size = 128;
      const result = await verifyNarrativeCapacity(program(t, name, edited), config);
      assert.equal(result.passed, true);
      assert.equal(result.compiled_modules, 3);
      assert.equal(result.checked[0].restored_waits, name === "grouped" ? 3 : 2);
      assert.equal(result.checked[0].scene_frames_at_wait, 2);
      assert.ok(result.checked[0].code_residency_observations.every((item) => item.residentModules <= 3));
    }
});
test("narrative verifier rejects invalid dimensions before opening a program", async () => {
  const base = { scenes: 1, rows: 2, rooms: [0] };
  for (const config of [
    { ...base, scenes: 0 },
    { ...base, scenes: 1023 },
    { ...base, rows: 0 },
    { ...base, rows: 100001 },
    { ...base, rooms: [] },
    { ...base, rooms: [0, 0, 0, 0] },
  ])
    await assert.rejects(verifyNarrativeCapacity("not-opened.txt", config), assert.AssertionError);
});
test("narrative verifier detects mismatched text and invalid routing descriptions", async (t) => {
  const path = program(t, "flat");
  await assert.rejects(verifyNarrativeCapacity(path, { scenes: 1, rows: 3, rooms: [0] }), assert.AssertionError);
  await assert.rejects(verifyNarrativeCapacity(path, { scenes: 1, rows: 2, rooms: [1] }), assert.AssertionError);
  await assert.rejects(
    verifyNarrativeCapacity(path, { scenes: 1, rows: 2, rooms: [0], routing_group_size: 64 }),
    assert.AssertionError,
  );
});

test("the narrative verifier CLI validates an explicit compiled package and reports actual restored waits", (t) => {
  const startup = program(t, "flat");
  const config = join(startup, "../case.json");
  writeFileSync(config, JSON.stringify({ scenes: 1, rows: 2, rooms: [0] }));
  const observer = process.env.BIFOIL_ISTANBUL_DIRECTORY
    ? ["--import", fileURLToPath(new URL("./coverage-register.mjs", import.meta.url))]
    : [];
  const result = spawnSync(process.execPath, [...observer, "tools/verify-narrative-capacity.mjs", startup, config], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
    timeout: process.env.BIFOIL_ISTANBUL_DIRECTORY ? 60000 : 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.equal(report.compiled_modules, 3);
  assert.equal(report.checked[0].restored_waits, 2);
});

test("narrative verification completes real setup across the default million-instruction quantum", async (t) => {
  const startup = program(t, "flat", false, true);
  const machine = new VM(await readCompiledProgram(startup));
  let first = machine.run();
  while (first.status === "loading") {
    await first.ready;
    first = machine.run();
  }
  assert.equal(first.status, "running");
  const report = await verifyNarrativeCapacity(startup, { scenes: 1, rows: 2, rooms: [0] });
  assert.equal(report.passed, true);
  assert.equal(report.checked[0].restored_waits, 2);
});
