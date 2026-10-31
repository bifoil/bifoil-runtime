import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { binary } from "../src/vm.mjs";
import { installChoiceScript } from "../src/choicescript.mjs";
import { splitCompiledProgram } from "./support/packages.mjs";
import { commandPayload } from "../src/packages.mjs";

const engine = process.env.CHOICESCRIPT_ENGINE;
test("unmodified ChoiceScript dispatcher runs the compiled extension", { skip: !engine }, () => {
  const context = vm.createContext({
    trim: (s) => s.trim(),
    num: (n) => {
      const result = Number(n);
      if (!Number.isFinite(result)) throw new Error("not numeric");
      return result;
    },
  });
  vm.runInContext(readFileSync(engine, "utf8"), context, { filename: "upstream-scene.js" });
  const { Scene } = context;
  const program = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
  let choose;
  const output = [];
  installChoiceScript(Scene, {
    print(scene, text) {
      output.push(text);
    },
    renderChoice(scene, options, select) {
      assert.equal(options[0].label, "Take 2 and ${literal}");
      choose = select;
    },
  });
  const scene = new Scene("startup", {}, {});
  assert.equal(scene.runCommand("*bifoil " + JSON.stringify(program)), true);
  choose(0);
  assert.deepEqual(output, ["Result 12; counter 2; next 3; after 3."]);
  // Deterministic cross-check against the authoritative operator implementation.
  for (let i = 0; i < 10000; i++) {
    const base = (i % 1001) / 10;
    const change = (((i * 97) % 2001) - 1000) / 3;
    for (const op of ["%+", "%-"]) {
      assert.equal(
        binary(op, { kind: "float", value: base }, { kind: "float", value: change }).value,
        Scene.operators[op](base, change, 1),
      );
    }
  }
});

test(
  "unmodified ChoiceScript dispatcher registers and executes verified code packages",
  { skip: !engine },
  async () => {
    const context = vm.createContext({ trim: (text) => text.trim() });
    vm.runInContext(readFileSync(engine, "utf8"), context, { filename: "upstream-scene.js" });
    const { Scene } = context;
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/checkpoint.json", import.meta.url), "utf8"));
    const data = splitCompiledProgram(fixture),
      stats = {},
      output = [];
    let choose;
    installChoiceScript(Scene, {
      print: (_scene, text) => output.push(text),
      renderChoice: (_scene, _options, select) => {
        choose = select;
      },
    });
    for (const [name, source] of data.sources) {
      const scene = new Scene(name, stats, {});
      assert.equal(scene.runCommand("*bifoil_module " + commandPayload(source, "bifoil_module").json), true);
    }
    const scene = new Scene("startup", stats, {});
    assert.equal(scene.runCommand("*bifoil " + JSON.stringify(data.manifest)), true);
    await scene.bifoilLoading;
    choose(0);
    assert.deepEqual(output, ["Result 12; counter 2; next 3; after 3."]);
  },
);
