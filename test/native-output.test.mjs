import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installChoiceScript } from "../src/choicescript.mjs";
import { nativeEngineHost } from "../src/legacy/node-host.mjs";
import { createChoiceScriptHost } from "../src/legacy/choicescript.mjs";

const engine = process.env.CHOICESCRIPT_ENGINE;
const fixture = JSON.parse(readFileSync(new URL("./fixtures/legacy.json", import.meta.url), "utf8"));
const request = { target: { scene: "native", label: null, result: null }, suspend: true, args: [] };

for (const kind of ["image", "chart", "line break"]) {
  test(`native publishers retain paragraph order around an engine-rendered ${kind}`, { skip: !engine }, () => {
    const events = [];
    const command = {
      image: "*image marker.png center Marker\n",
      chart: "*stat_chart\n    text calls Calls\n",
      "line break": "\n*line_break\n",
    }[kind];
    const native = nativeEngineHost(
      engine,
      { native: "Before.\n" + command + "After.\n*page_break Next\n*return\n" },
      { calls: 0 },
      { publishOutput: (paragraphs) => events.push(...paragraphs) },
    );
    native.context.printImage = (source) => events.push("image:" + source);
    native.context.println = () => events.push("line break");
    native.context.document = {
      getElementById: () => ({ appendChild: (node) => events.push("chart:" + node.children[0].text) }),
      createElement: () => ({
        children: [],
        appendChild(child) {
          this.children.push(child);
        },
      }),
    };
    native.context.setClass = () => {};
    native.context.printx = (text, node) => {
      node.text = text;
    };
    const reply = native.host.start(request);
    const rendered = { image: "image:marker.png", chart: "chart:Calls: 0", "line break": "line break" }[kind];
    assert.deepEqual(events, ["Before.", rendered, "After."]);
    assert.deepEqual(reply.output, []);
    assert.equal(reply.status, "waiting");
  });
}

test("empty native returns never publish a prose-splitting rendering boundary", { skip: !engine }, () => {
  const published = [];
  const native = nativeEngineHost(
    engine,
    { native: "*return\n" },
    {},
    { publishOutput: (paragraphs) => published.push(paragraphs) },
  );
  assert.equal(native.host.start(request).status, "returned");
  assert.deepEqual(published, []);
});

function renderer(program, initial = {}, custom = false) {
  const native = nativeEngineHost(engine, program.legacy_sources, initial);
  const events = [],
    choices = [];
  native.context.printImage = (source) => events.push("image:" + source);
  const adapter = installChoiceScript(native.context.Scene, {
    legacy: custom
      ? (scene, program, options) =>
          createChoiceScriptHost(native.context.Scene, scene, program.legacy_sources, options)
      : undefined,
    print: (scene, text) => events.push(text),
    renderChoice: (scene, options, select) => choices.push({ options, select }),
    finish: () => events.push("finished"),
  });
  return { ...native, adapter, events, choices };
}

function story(tail) {
  const program = structuredClone(fixture);
  program.legacy_sources.questions =
    "*label ask\n*set calls + 1\nBefore.\n*image marker.png center Marker\nAfter.\n" + tail;
  return program;
}

test("the web adapter streams native paragraphs once and restores without replaying images", { skip: !engine }, () => {
  const program = story("*page_break Next\n*set answer (2 + 3)\n*return\n");
  const first = renderer(program, { calls: 0, answer: 0 }, true);
  first.parent.bifoil(JSON.stringify(program));
  assert.deepEqual(first.events, ["Before.", "image:marker.png", "After."]);
  assert.deepEqual(first.parent.bifoilSession.machine.state.transcript, ["Before.", "After."]);
  assert.equal(first.stats.calls, 2);
  const checkpoint = first.parent.stats.bifoil_checkpoint;

  const second = renderer(program);
  second.adapter.restore(second.parent, program, checkpoint);
  assert.deepEqual(second.events, []);
  assert.equal(second.stats.calls, 2);
  assert.deepEqual(second.choices[0].options, [{ label: "Next", enabled: true }]);
  second.choices[0].select(0);
  assert.equal(second.stats.calls, 3);
  assert.deepEqual(second.events, []);
  assert.deepEqual(second.choices[1].options, [{ label: "Finish 3", enabled: true }]);
  second.choices[1].select(0);
  assert.deepEqual(second.events, ["9|3", "finished"]);
  assert.deepEqual(second.parent.bifoilSession.machine.state.transcript, ["Before.", "After.", "9|3"]);
});

test("native rendering followed by failure keeps completed output exactly once", { skip: !engine }, () => {
  const program = story("*set missing 1\n*return\n");
  const native = renderer(program, { calls: 0, answer: 0 });
  assert.throws(() => native.parent.bifoil(JSON.stringify(program)), /Non-existent variable/);
  assert.deepEqual(native.events, ["Before.", "image:marker.png", "After."]);
  assert.throws(() => native.parent.bifoilSession.run(), /Non-existent variable/);
  assert.deepEqual(native.events, ["Before.", "image:marker.png", "After."]);
});
