import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runCli } from "../src/cli.mjs";

function terminal(t, responses = []) {
  const input = new PassThrough(),
    output = new PassThrough(),
    printed = [],
    errors = [];
  const choices = [...responses];
  output.on("data", (chunk) => {
    if (chunk.toString().includes("> ")) queueMicrotask(() => input.write(choices.shift() + "\n"));
  });
  t.after(() => {
    input.destroy();
    output.destroy();
  });
  return {
    input,
    output,
    printed,
    errors,
    print: (line) => printed.push(line),
    errorOutput: (line) => errors.push(line),
  };
}
function fixture(t, name = "ordering") {
  const root = mkdtempSync(join(tmpdir(), "bifoil-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const program = readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
  const source = join(root, "startup.txt");
  writeFileSync(source, "*bifoil " + JSON.stringify(JSON.parse(program)));
  return { root, source };
}

test("CLI runs an authored program and prints completed narrative", async (t) => {
  const io = terminal(t),
    { source } = fixture(t);
  assert.equal(await runCli([source], io), 0);
  assert.deepEqual(io.printed, ["3 sd1d2\n"]);
  assert.deepEqual(io.errors, []);
});
test("CLI saves a prepared wait and restores without replaying completed evaluation", async (t) => {
  const first = terminal(t),
    { root, source } = fixture(t, "checkpoint");
  const saved = join(root, "save.json");
  assert.equal(await runCli([source, "--save", saved], first), 0);
  assert.equal(existsSync(saved), true);
  assert.match(first.printed.at(-1), /Saved input checkpoint/);
  const second = terminal(t, ["1"]);
  assert.equal(await runCli([source, "--load", saved], second), 0);
  assert.equal(second.printed.at(-1), "Result 12; counter 2; next 3; after 3.\n");
  assert.deepEqual(second.errors, []);
});
test("CLI diagnoses missing programs and malformed or duplicated options", async (t) => {
  const { source } = fixture(t);
  for (const args of [[], [source, "--unknown", "x"], [source, "--save"], [source, "--save", "a", "--save", "b"]]) {
    const io = terminal(t);
    assert.equal(await runCli(args, io), 1);
    assert.equal(io.errors.length, 1);
    assert.match(io.errors[0], /STARTUP|invalid CLI option/);
  }
});
test("CLI reports source errors and requires an explicitly selected legacy engine", async (t) => {
  const { source, root } = fixture(t, "overflow");
  const overflow = terminal(t);
  assert.equal(await runCli([source], overflow), 1);
  assert.match(overflow.errors[0], /Int overflow/);
  const legacy = JSON.parse(readFileSync(new URL("./fixtures/legacy.json", import.meta.url), "utf8"));
  writeFileSync(source, "*bifoil " + JSON.stringify(legacy));
  const missing = terminal(t);
  assert.equal(await runCli([source], missing), 1);
  assert.match(missing.errors[0], /requires --engine/);
  const invalid = join(root, "invalid.txt");
  writeFileSync(invalid, "invalid");
  const io = terminal(t);
  assert.equal(await runCli([invalid], io), 1);
  assert.ok(io.errors[0].length > 0);
});

test("CLI runs explicit native bridges with supplied state and restores native input checkpoints", async (t) => {
  assert.ok(process.env.CHOICESCRIPT_ENGINE, "Set CHOICESCRIPT_ENGINE to the pinned engine");
  const { root, source } = fixture(t, "legacy");
  const state = join(root, "legacy.json"),
    checkpoint = join(root, "legacy-save.json");
  writeFileSync(state, JSON.stringify({ calls: 0, answer: 0 }));
  const options = [source, "--engine", process.env.CHOICESCRIPT_ENGINE, "--legacy-stats", state];
  const first = terminal(t);
  assert.equal(await runCli([...options, "--save", checkpoint], first), 0, first.errors.join("\n"));
  const restored = terminal(t, ["1", "1"]);
  assert.equal(await runCli([...options, "--load", checkpoint], restored), 0, restored.errors.join("\n"));
  assert.equal(restored.printed.at(-1), "9|3\n");
  writeFileSync(state, "invalid JSON");
  const invalid = terminal(t);
  assert.equal(await runCli(options, invalid), 1);
  assert.ok(invalid.errors[0].length > 0);
});
