import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
