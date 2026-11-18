import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("anonymous imports of development entrypoints perform no CLI operations", () => {
  const observer = process.env.BIFOIL_ISTANBUL_DIRECTORY
    ? ["--import", fileURLToPath(new URL("./coverage-register.mjs", import.meta.url))]
    : [];
  const imports = [
    "./tools/collect-coverage.mjs",
    "./tools/execute-conformance.mjs",
    "./tools/serve-browser.mjs",
    "./tools/verify-narrative-capacity.mjs",
  ];
  const result = spawnSync(
    process.execPath,
    [
      ...observer,
      "--input-type=module",
      "--eval",
      `for (const source of ${JSON.stringify(imports)}) await import(source);`,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      timeout: process.env.BIFOIL_ISTANBUL_DIRECTORY ? 60000 : 10000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
