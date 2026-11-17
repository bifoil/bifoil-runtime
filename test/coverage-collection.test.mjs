import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import instrument from "istanbul-lib-instrument";
import { collectCoverage, normalizeSources } from "../tools/collect-coverage.mjs";

/** @param {import("node:test").TestContext} t
 * @param {unknown} [config]
 */
function fixture(t, config = { includes: ["src/**"], directory: "coverage" }) {
  const root = mkdtempSync(join(tmpdir(), "bifoil-coverage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "test"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "test/example.test.mjs"), "");
  writeFileSync(join(root, "src/example.mjs"), "export const answer = 42;\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ bifoilQuality: config }));
  return root;
}
function reporter(root, { result = { status: 0 }, empty = false, counts = [1] } = {}) {
  return (_node, args, options) => {
    assert.equal(options.cwd, root);
    assert.ok(args.includes("--import"));
    assert.ok(args.includes(join(root, "test/coverage-register.mjs")));
    assert.ok(args.includes("test/example.test.mjs"));
    const destination = args.find((arg) => arg.startsWith("--test-reporter-destination="));
    writeFileSync(destination.slice("--test-reporter-destination=".length), "tests passed");
    if (!empty)
      for (const [index, hits] of counts.entries()) {
        const observer = instrument.createInstrumenter({ esModules: true, compact: false });
        observer.instrumentSync(readFileSync(join(root, "src/example.mjs"), "utf8"), "src/example.mjs");
        const model = observer.lastFileCoverage();
        model.s[0] = hits;
        writeFileSync(
          join(options.env.BIFOIL_ISTANBUL_DIRECTORY, index + ".json"),
          JSON.stringify({ "src/example.mjs": model }),
        );
      }
    return result;
  };
}

test("coverage paths are normalized without changing counters", () => {
  assert.equal(normalizeSources("SF:/repo/src/main.mjs\nDA:1,3\n", "/repo"), "SF:src/main.mjs\nDA:1,3\n");
  assert.equal(normalizeSources("SF:src/main.mjs\n", "/repo"), "SF:src/main.mjs\n");
  assert.throws(() => normalizeSources("SF:/outside/main.mjs\n", "/repo"), /escapes/);
  assert.throws(() => normalizeSources("SF:../outside.mjs\n", "/repo"), /escapes/);
  assert.throws(() => normalizeSources("", "/repo"), /no source coverage/);
  assert.throws(() => normalizeSources("SF:..\\outside.mjs\n", "/repo"), /escapes/);
  assert.equal(normalizeSources("SF:src/main.mjs\r\n", "/repo"), "SF:src/main.mjs\n");
});
test("collection merges repeated source imports and retains unimported sources as zero", (t) => {
  const root = fixture(t, { includes: ["src/**"], directory: "coverage", requiredEnvironment: ["PATH"] });
  mkdirSync(join(root, "src/assets"));
  writeFileSync(join(root, "src/assets/README.md"), "data");
  writeFileSync(join(root, "src/unimported.mjs"), "export const untested = true;\n");
  const report = collectCoverage(root, reporter(root, { counts: [1, 2] }));
  const lcov = readFileSync(report, "utf8");
  assert.match(lcov, /SF:src\/example.mjs\n(?:.*\n)*?DA:1,3/);
  assert.match(lcov, /SF:src\/unimported.mjs\n(?:.*\n)*?DA:1,0/);
  assert.equal(lcov.match(/SF:src\/example.mjs/g).length, 1);
  assert.equal(readFileSync(join(root, "coverage/tests.log"), "utf8"), "tests passed");
  assert.deepEqual(readdirSync(join(root, "coverage")).sort(), [
    "coverage-sources.json",
    "coverage-summary.json",
    "coverage.lcov",
    "tests.log",
  ]);
});
test("failed tests and runner launch errors invalidate an earlier report", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "coverage"));
  for (const result of [{ status: 1 }, { status: null, error: new Error("launch failed") }]) {
    writeFileSync(join(root, "coverage/coverage.lcov"), "stale");
    assert.throws(() => collectCoverage(root, reporter(root, { result })), /failed/);
    assert.equal(existsSync(join(root, "coverage/coverage.lcov")), false);
    assert.equal(
      readdirSync(join(root, "coverage")).some((name) => name.startsWith("pending-")),
      false,
    );
  }
});
test("an empty counter directory cannot replace completed coverage", (t) => {
  const root = fixture(t);
  assert.throws(() => collectCoverage(root, reporter(root, { empty: true })), /no source coverage/);
  assert.equal(existsSync(join(root, "coverage/coverage.lcov")), false);
});
test("configuration, environment, output boundary and test discovery are checked", (t) => {
  for (const config of [null, {}, { includes: [] }]) {
    const root = fixture(t, config);
    assert.throws(() => collectCoverage(root), /must declare/);
  }
  const missing = fixture(t, {
    includes: ["src/**"],
    directory: "coverage",
    requiredEnvironment: ["BIFOIL_NONEXISTENT_COVERAGE_TEST_VARIABLE"],
  });
  assert.throws(() => collectCoverage(missing), /requires an explicit/);
  const escaped = fixture(t, { includes: ["src/**"], directory: "../outside" });
  assert.throws(() => collectCoverage(escaped), /stay inside/);
  const empty = fixture(t);
  rmSync(join(empty, "test/example.test.mjs"));
  assert.throws(() => collectCoverage(empty), /No test files/);
  const invalid = fixture(t, { includes: ["../outside/**"], directory: "coverage" });
  assert.throws(() => collectCoverage(invalid), /source directories/);
});

test("source edits during a test run invalidate its coverage evidence", (t) => {
  const root = fixture(t);
  const execute = reporter(root);
  const run = (...args) => {
    const result = execute(...args);
    writeFileSync(join(root, "src/example.mjs"), "export const answer = 43;\n");
    return result;
  };
  assert.throws(() => collectCoverage(root, run), /source changed during tests/);
  assert.equal(existsSync(join(root, "coverage/coverage.lcov")), false);
});
