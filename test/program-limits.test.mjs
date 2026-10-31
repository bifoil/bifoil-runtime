import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateProgram } from "../src/program.mjs";
import {
  MAX_FUNCTIONS,
  MAX_INSTRUCTIONS,
  MAX_MODULE_INSTRUCTIONS,
  MAX_MODULE_FUNCTIONS,
  MAX_MODULES,
} from "../src/program-limits.mjs";
import { loadPackage } from "../src/packages.mjs";
import { splitCompiledProgram } from "./support/packages.mjs";

function oversizedFunctionTable() {
  const program = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  const existing = Object.keys(program.functions).length;
  for (let index = existing; index <= MAX_FUNCTIONS; index++) {
    const id = `wide${Math.floor(index / MAX_MODULE_FUNCTIONS)}.f${index}`;
    program.functions[id] = { signature: { id }, code: [] };
  }
  return program;
}

test("inline loading rejects a function table beyond the shared profile limit", () => {
  assert.throws(() => validateProgram(oversizedFunctionTable()), /function budget exceeded/);
});

test("package loading bounds the combined function table before execution", async () => {
  const data = splitCompiledProgram(oversizedFunctionTable());
  await assert.rejects(
    loadPackage(data.manifest, (name) => data.sources.get(name)),
    /compiled package code budget exceeded/,
  );
});

test("package module inventory is bounded before any companion scene is fetched", async () => {
  const program = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  const existing = new Set(Object.keys(program.functions).map((id) => id.split(".")[0])).size;
  for (let index = existing; index <= MAX_MODULES; index++) {
    const id = "extra_module" + index + ".routine";
    program.functions[id] = { signature: { id }, code: [] };
  }
  const data = splitCompiledProgram(program);
  let fetched = 0;
  await assert.rejects(
    loadPackage(data.manifest, () => {
      fetched++;
      throw new Error("oversized inventory must not fetch code");
    }),
    /invalid package module inventory/,
  );
  assert.equal(fetched, 0);
});

function fixtureWithCode(total, perModule) {
  const program = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  let remaining = total - Object.values(program.functions).reduce((count, fn) => count + fn.code.length, 0);
  const instruction = { op: "pop", span: { file: "src/limits.bfl", line: 1 } };
  for (let index = 0; remaining > 0; index++) {
    const size = Math.min(remaining, perModule),
      id = `capacity${index}.routine`;
    program.functions[id] = {
      signature: { id, params: [], result: { kind: "unit" }, suspend: false, scene: false },
      code: Array(size).fill(instruction),
      init: false,
    };
    remaining -= size;
  }
  return program;
}

test("inline validation accepts the aggregate boundary and rejects its next instruction", () => {
  const program = fixtureWithCode(MAX_INSTRUCTIONS, MAX_INSTRUCTIONS);
  assert.equal(validateProgram(program), program);
  const code = program.functions["capacity0.routine"].code;
  code.push(code[0]);
  assert.throws(() => validateProgram(program), /instruction budget exceeded/);
});

test("package loading accepts independent module bodies up to the aggregate boundary", async () => {
  const program = fixtureWithCode(MAX_INSTRUCTIONS, MAX_MODULE_INSTRUCTIONS);
  const data = splitCompiledProgram(program);
  const loaded = await loadPackage(data.manifest, (name) => data.sources.get(name));
  assert.equal(
    Object.values(loaded.functions).reduce((count, fn) => count + fn.code.length, 0),
    MAX_INSTRUCTIONS,
  );
  const last = Object.values(program.functions).at(-1).code;
  last.push(last[0]);
  const excessive = splitCompiledProgram(program);
  await assert.rejects(
    loadPackage(excessive.manifest, (name) => excessive.sources.get(name)),
    /compiled package code budget exceeded/,
  );
});

test("a package cannot use the aggregate allowance for an oversized individual module", async () => {
  const program = fixtureWithCode(MAX_MODULE_INSTRUCTIONS + 200, MAX_MODULE_INSTRUCTIONS + 1);
  const data = splitCompiledProgram(program);
  await assert.rejects(
    loadPackage(data.manifest, (name) => data.sources.get(name)),
    /compiled module code budget exceeded/,
  );
});

function fixtureWithFunctions(total, perModule = MAX_MODULE_FUNCTIONS) {
  const program = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  const existing = Object.keys(program.functions).length;
  const span = { file: "src/limits.bfl", line: 1 };
  const code = [
    { op: "constant", ty: { kind: "unit" }, value: null, span },
    { op: "return", span },
  ];
  for (let index = 0; index < total - existing; index++) {
    const id = `table${Math.floor(index / perModule)}.f${index}`;
    program.functions[id] = {
      signature: { id, params: [], result: { kind: "unit" }, suspend: false, scene: false },
      code,
      init: false,
    };
  }
  return program;
}

test("inline validation accepts the aggregate function boundary and rejects its successor", () => {
  const program = fixtureWithFunctions(MAX_FUNCTIONS);
  assert.equal(validateProgram(program), program);
  const id = "extra.routine";
  program.functions[id] = {
    ...program.functions["table0.f0"],
    signature: { ...program.functions["table0.f0"].signature, id },
  };
  assert.throws(() => validateProgram(program), /function budget exceeded/);
});

test("packages accept the aggregate function boundary and reject its successor", async () => {
  const data = splitCompiledProgram(fixtureWithFunctions(MAX_FUNCTIONS));
  const program = await loadPackage(data.manifest, (name) => data.sources.get(name));
  assert.equal(Object.keys(program.functions).length, MAX_FUNCTIONS);
  const excessive = splitCompiledProgram(fixtureWithFunctions(MAX_FUNCTIONS + 1));
  await assert.rejects(
    loadPackage(excessive.manifest, (name) => excessive.sources.get(name)),
    /compiled package code budget exceeded/,
  );
});

test("each package module retains its independent function-count bound", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  const count = Object.keys(fixture.functions).length + MAX_MODULE_FUNCTIONS + 1;
  const data = splitCompiledProgram(fixtureWithFunctions(count, MAX_MODULE_FUNCTIONS + 1));
  await assert.rejects(
    loadPackage(data.manifest, (name) => data.sources.get(name)),
    /compiled module function budget exceeded/,
  );
});
