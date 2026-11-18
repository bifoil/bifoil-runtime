import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeConformance } from "../tools/execute-conformance.mjs";
import { loadCompiledProgram } from "../src/packages.mjs";
import { splitCompiledProgram } from "./support/packages.mjs";
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("conformance runner preserves selections through checkpoint restoration", async () => {
  const result = await executeConformance(fixture("checkpoint"), { choices: [0], quantum: 1 });
  assert.equal(result.error, null);
  assert.deepEqual(result.options, [["Take 2 and ${literal}"]]);
  assert.deepEqual(result.output, ["Result 12; counter 2; next 3; after 3."]);
});
test("conformance runner rejects missing or unused selections and reports runtime errors", async () => {
  assert.match((await executeConformance(fixture("checkpoint"), {})).error, /needs a selection/);
  assert.match((await executeConformance(fixture("ordering"), { choices: [0] })).error, /unused case/);
  assert.match((await executeConformance(fixture("overflow"), {})).error, /Int overflow/);
  const legacy = await executeConformance(fixture("legacy"), { choices: [0] });
  assert.match(legacy.error, /explicit --engine/);
});
test("conformance runner awaits code packages and uses an explicit engine for native bridges", async () => {
  const data = splitCompiledProgram(fixture("checkpoint"), { lazy: true });
  const program = await loadCompiledProgram(data.startup, (name) => data.sources.get(name));
  assert.equal((await executeConformance(program, { choices: [0] })).error, null);
  assert.ok(process.env.CHOICESCRIPT_ENGINE, "Set CHOICESCRIPT_ENGINE to the pinned engine");
  const result = await executeConformance(fixture("legacy"), {
    choices: [0, 0],
    native_engine: process.env.CHOICESCRIPT_ENGINE,
    legacy_stats: { calls: 0, answer: 0 },
  });
  assert.equal(result.error, null);
  assert.ok(result.output.length > 0);
});

test("conformance restores native numeric input before selecting the later compiled choice", async () => {
  assert.ok(process.env.CHOICESCRIPT_ENGINE, "Set CHOICESCRIPT_ENGINE to the pinned engine");
  const program = fixture("legacy");
  program.legacy_sources.questions = "*label ask\n*set calls + 1\n*input_number answer 1 9\n*return\n";
  const result = await executeConformance(program, {
    choices: ["5", 0],
    native_engine: process.env.CHOICESCRIPT_ENGINE,
    legacy_stats: { calls: 0, answer: 0 },
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.options[0], []);
  assert.deepEqual(result.output, ["9|3"]);
});

test("the conformance CLI reads its explicit program/config and emits the complete API result", async (t) => {
  const input = fixture("ordering");
  const expected = await executeConformance(input, {});
  assert.equal(expected.error, null);
  const root = mkdtempSync(join(tmpdir(), "bifoil-conformance-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const program = join(root, "startup.txt"),
    config = join(root, "case.json");
  writeFileSync(program, "*bifoil " + JSON.stringify(input) + "\n");
  writeFileSync(config, "{}");
  const observer = process.env.BIFOIL_ISTANBUL_DIRECTORY
    ? ["--import", fileURLToPath(new URL("./coverage-register.mjs", import.meta.url))]
    : [];
  const result = spawnSync(process.execPath, [...observer, "tools/execute-conformance.mjs", program, config], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
    timeout: process.env.BIFOIL_ISTANBUL_DIRECTORY ? 60000 : 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
});
