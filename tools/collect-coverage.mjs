/** Standalone Istanbul collector, format bifoil.node-coverage.v2. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function normalizeSources(lcov, root) {
  let records = 0;
  const result = lcov.replace(/^SF:([^\r\n]+)\r?$/gm, (_, source) => {
    const file = (isAbsolute(source) ? relative(root, source) : source).replaceAll("\\", "/");
    if (file === ".." || file.startsWith("../") || isAbsolute(file) || /^[A-Za-z]:/.test(file)) {
      throw new Error("Coverage source escapes the repository");
    }
    records++;
    return "SF:" + file;
  });
  if (!records) throw new Error("The test runner produced no source coverage");
  return result;
}

function seedSources(root, includes) {
  // Importing a development entrypoint must not initialize the instrumentation
  // toolchain. Load its dependencies only when collection actually starts.
  const merged = require("istanbul-lib-coverage").createCoverageMap({});
  const hashes = {};
  const observer = require("istanbul-lib-instrument").createInstrumenter({ esModules: true, compact: false });
  for (const pattern of includes) {
    if (!/^[a-z0-9_-]+\/\*\*$/.test(pattern)) throw new Error("Coverage includes must name source directories");
    const directory = pattern.slice(0, -3);
    for (const file of readdirSync(join(root, directory), { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".mjs")) continue;
      const name = relative(root, join(file.parentPath, file.name)).replaceAll("\\", "/");
      const bytes = readFileSync(join(root, name));
      observer.instrumentSync(bytes.toString("utf8"), name);
      hashes[name] = createHash("sha256").update(bytes).digest("hex");
      merged.addFileCoverage(observer.lastFileCoverage());
    }
  }
  return { merged, hashes };
}

/** @param {string} root
 * @param {(command: string, args: string[], options: import("node:child_process").SpawnSyncOptions) =>
 *   {status: number | null, error?: Error}} [run]
 */
export function collectCoverage(root, run = spawnSync) {
  const config = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).bifoilQuality;
  if (!config || !Array.isArray(config.includes) || !config.includes.length) {
    throw new Error("package.json must declare bifoilQuality.includes");
  }
  for (const name of config.requiredEnvironment ?? []) {
    if (!process.env[name]) throw new Error("Coverage requires an explicit " + name);
  }
  const directory = resolve(root, config.directory);
  const local = relative(resolve(root), directory);
  if (!local || local === ".." || local.startsWith("../") || local.startsWith("..\\") || isAbsolute(local)) {
    throw new Error("Coverage output must stay inside the repository");
  }
  const tests = readdirSync(join(root, "test"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort();
  if (!tests.length) throw new Error("No test files found");
  mkdirSync(directory, { recursive: true });
  const report = join(directory, "coverage.lcov");
  for (const file of [report, join(directory, "coverage-summary.json"), join(directory, "coverage-sources.json")])
    rmSync(file, { force: true });
  const temporary = mkdtempSync(join(directory, "pending-"));
  try {
    const { merged, hashes } = seedSources(root, config.includes);
    const counters = join(temporary, "counters");
    mkdirSync(counters);
    const result = run(
      process.execPath,
      [
        "--import",
        join(root, "test/coverage-register.mjs"),
        "--test",
        "--test-concurrency=2",
        "--test-reporter=spec",
        "--test-reporter-destination=" + join(temporary, "tests.log"),
        ...tests.map((name) => join("test", name)),
      ],
      { cwd: root, env: { ...process.env, BIFOIL_ISTANBUL_DIRECTORY: counters }, stdio: "inherit" },
    );
    if (existsSync(join(temporary, "tests.log"))) {
      renameSync(join(temporary, "tests.log"), join(directory, "tests.log"));
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Coverage tests failed (exit " + result.status + ")");
    const files = readdirSync(counters).filter((name) => name.endsWith(".json"));
    if (!files.length) throw new Error("The test runner produced no source coverage");
    for (const name of files) merged.merge(JSON.parse(readFileSync(join(counters, name), "utf8")));
    for (const [name, expected] of Object.entries(hashes)) {
      const current = createHash("sha256")
        .update(readFileSync(join(root, name)))
        .digest("hex");
      if (current !== expected) throw new Error("Coverage source changed during tests: " + name);
    }
    const context = require("istanbul-lib-report").createContext({ dir: temporary, coverageMap: merged });
    require("istanbul-reports").create("lcovonly", { file: "coverage.lcov" }).execute(context);
    const lcov = normalizeSources(readFileSync(join(temporary, "coverage.lcov"), "utf8"), root);
    writeFileSync(join(temporary, "coverage.lcov"), lcov);
    writeFileSync(
      join(directory, "coverage-summary.json"),
      JSON.stringify(merged.getCoverageSummary().toJSON(), null, 2) + "\n",
    );
    writeFileSync(join(directory, "coverage-sources.json"), JSON.stringify(hashes, null, 2) + "\n");
    renameSync(join(temporary, "coverage.lcov"), report);
    return report;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log("Coverage report: " + collectCoverage(dirname(dirname(fileURLToPath(import.meta.url)))));
}
