import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { print } from "../src/presentation.mjs";
import { nativeEngineHost } from "../src/legacy/node-host.mjs";

test("default presentation maps newline scalars to visible native line breaks once", () => {
  const paragraphs = [];
  const scene = {
    accumulatedParagraph: [],
    paragraph() {
      paragraphs.push(this.accumulatedParagraph.join(""));
      this.accumulatedParagraph = [];
    },
  };
  print(scene, "First\nSecond\r\nThird\rFourth");
  print(scene, "Literal \\n and ${literal}");
  assert.deepEqual(paragraphs, ["First[n/]Second[n/]Third[n/]Fourth", "Literal \\n and ${literal}"]);
});

const engine = process.env.CHOICESCRIPT_ENGINE;
test("the pinned native paragraph renderer displays breaks without interpolating text again", { skip: !engine }, () => {
  const { context, parent } = nativeEngineHost(engine);
  const paragraphs = [];
  const target = { appendChild: (node) => paragraphs.push(node) };
  context.window = { addEventListener: () => undefined };
  context.document = {
    getElementById: () => target,
    createElement: (tag) => ({ tag, innerHTML: "" }),
  };
  vm.runInContext(readFileSync(join(dirname(engine), "ui.js"), "utf8"), context, { filename: "upstream-ui.js" });
  print(parent, "First\nSecond <literal> ${untouched}");
  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].tag, "p");
  assert.equal(paragraphs[0].innerHTML, "First<br>Second &lt;literal&gt; ${untouched}");
});
