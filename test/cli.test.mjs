import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.mjs";
import { VM } from "../src/vm.mjs";
import { splitCompiledProgram } from "./support/packages.mjs";

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

test("CLI default terminal dependencies report usage and complete noninteractive stories", async (t) => {
  const printed = t.mock.method(console, "log", () => {});
  const errors = t.mock.method(console, "error", () => {});
  assert.equal(await runCli([]), 1);
  assert.match(errors.mock.calls[0].arguments[0], /STARTUP/);
  const { source } = fixture(t);
  assert.equal(await runCli([source]), 0);
  assert.deepEqual(
    printed.mock.calls.map((call) => call.arguments[0]),
    ["3 sd1d2\n"],
  );
  assert.equal(errors.mock.callCount(), 1);
});

test("CLI entry dispatches only direct invocation, including anonymous module hosts", (t) => {
  // Source instrumentation adds startup work; keep the ordinary CLI deadline strict.
  const timeout = process.env.BIFOIL_ISTANBUL_DIRECTORY ? 60000 : 10000;
  const observer = process.env.BIFOIL_ISTANBUL_DIRECTORY
    ? ["--import", fileURLToPath(new URL("./coverage-register.mjs", import.meta.url))]
    : [];
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { source } = fixture(t);
  const direct = spawnSync(process.execPath, [...observer, "src/cli.mjs", source], {
    cwd: root,
    encoding: "utf8",
    timeout,
  });
  assert.equal(direct.error, undefined);
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stdout, "3 sd1d2\n\n");
  const anonymous = spawnSync(
    process.execPath,
    [
      ...observer,
      "--input-type=module",
      "--eval",
      'await import("./src/cli.mjs"); process.stdout.write("Original anonymous import completed\\n");',
    ],
    { cwd: root, encoding: "utf8", timeout },
  );
  assert.equal(anonymous.error, undefined);
  assert.equal(anonymous.status, 0, anonymous.stderr);
  assert.equal(anonymous.stdout, "Original anonymous import completed\n");
  assert.equal(anonymous.stderr, "");
});

test("CLI yields between real execution slices without repeating completed narrative", async (t) => {
  const run = VM.prototype.run;
  t.mock.method(VM.prototype, "run", function () {
    return run.call(this, 1);
  });
  const { source } = fixture(t);
  const io = terminal(t);
  assert.equal(await runCli([source], io), 0);
  assert.deepEqual(io.printed, ["3 sd1d2\n"]);
  assert.deepEqual(io.errors, []);
});

test("CLI awaits lazy companion packages before rendering their completed output", async (t) => {
  const { root, source } = fixture(t);
  const program = JSON.parse(readFileSync(new URL("./fixtures/ordering.json", import.meta.url), "utf8"));
  const data = splitCompiledProgram(program, { lazy: true });
  writeFileSync(source, data.startup);
  for (const [name, contents] of data.sources) writeFileSync(join(root, name + ".txt"), contents);
  const io = terminal(t);
  assert.equal(await runCli([source], io), 0, io.errors.join("\n"));
  assert.deepEqual(io.printed, ["3 sd1d2\n"]);
});

test("CLI labels visible disabled options while preserving a prepared save", async (t) => {
  const { root, source } = fixture(t, "checkpoint");
  const program = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  const option = program.functions["main.start$ask@9"].code;
  option[1].value = true;
  option[3].value = false;
  writeFileSync(source, "*bifoil " + JSON.stringify(program));
  const io = terminal(t);
  const saved = join(root, "disabled-option-save.json");
  assert.equal(await runCli([source, "--save", saved], io), 0);
  assert.match(io.printed[0], /^1\. Hidden 2 \[disabled\]$/);
  assert.match(io.printed[1], /^2\. Take 3/);
  assert.equal(existsSync(saved), true);
  assert.deepEqual(io.errors, []);
});

test("CLI retries invalid native number input with its prepared feedback", async (t) => {
  const { root, source } = fixture(t, "legacy");
  const program = JSON.parse(readFileSync(new URL("./fixtures/legacy.json", import.meta.url), "utf8"));
  program.legacy_sources.questions = "*label ask\n*set calls + 1\n*input_number answer 1 9\n*return\n";
  writeFileSync(source, "*bifoil " + JSON.stringify(program));
  const state = join(root, "input-state.json");
  writeFileSync(state, JSON.stringify({ calls: 0, answer: 0 }));
  const io = terminal(t, ["x", "7", "1"]);
  assert.equal(await runCli([source, "--engine", process.env.CHOICESCRIPT_ENGINE, "--legacy-stats", state], io), 0);
  assert.ok(
    io.printed.some((line) => /number/i.test(line)),
    "native input feedback was not printed",
  );
  assert.deepEqual(io.errors, []);
});
