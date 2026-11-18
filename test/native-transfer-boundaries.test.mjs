import test from "node:test";
import assert from "node:assert/strict";
import { nativeEngineHost } from "../src/legacy/node-host.mjs";
import { createChoiceScriptHost } from "../src/legacy/choicescript.mjs";

const engine = process.env.CHOICESCRIPT_ENGINE;
const request = (transfer) => ({
  target: { scene: "native", label: null, result: null, transfer },
  suspend: true,
  args: [],
});

test("explicit native chapter transfers preserve prepared output across fresh-engine resume", { skip: !engine }, () => {
  for (const [source, next, label] of [
    ["*finish\n", "*ending\n", null],
    ["*finish\n", null, null],
    ["Original intro.\n*finish\n", "Original next.\n*ending\n", "Next Chapter"],
    ["Original intro.\n*finish Continue onward\n", "Original next.\n*ending\n", "Continue onward"],
    ["Original intro.\n", "Original next.\n*ending\n", "Next Chapter"],
  ]) {
    const sources = { native: source, ...(next === null ? {} : { next }) };
    const first = nativeEngineHost(engine, sources);
    const reply = first.host.start(request(true));
    if (label === null) {
      assert.equal(reply.status, "transferred");
      assert.deepEqual(reply.output, []);
    } else {
      assert.equal(reply.status, "waiting");
      assert.deepEqual(reply.options, [{ label, enabled: true }]);
      assert.deepEqual(reply.output, ["Original intro."]);
      const fresh = nativeEngineHost(engine, sources);
      const completed = fresh.host.resume(request(true), JSON.parse(JSON.stringify(reply.continuation)), 0);
      assert.equal(completed.status, "transferred");
      assert.deepEqual(completed.output, ["Original next."]);
      assert.equal(fresh.stats.scene, fresh.parent);
    }
  }
});

test(
  "nested native options retain disabled parent availability in flattened selection paths",
  { skip: !engine },
  () => {
    const sources = {
      native:
        "*choice color animal\n  *selectable_if (false) #Red\n    #Cat\n      *return\n  #Blue\n    #Cat\n      *return\n",
    };
    const first = nativeEngineHost(engine, sources);
    const reply = first.host.start(request(false));
    assert.deepEqual(reply.options, [
      { label: "Red / Cat", enabled: false },
      { label: "Blue / Cat", enabled: true },
    ]);
    const fresh = nativeEngineHost(engine, sources);
    assert.throws(() => fresh.host.resume(request(false), reply.continuation, 0), /invalid native selection/);
    assert.equal(fresh.host.resume(request(false), reply.continuation, 1).status, "returned");
  },
);

test("native waits can snapshot and restore without a navigation object", { skip: !engine }, () => {
  const sources = { native: "*page_break\nOriginal.\n*page_break\n*return\n" };
  const first = nativeEngineHost(engine, sources);
  first.parent.nav = null;
  const saved = first.host.snapshot();
  first.host.restore(saved);
  const reply = first.host.start(request(false));
  assert.deepEqual(reply.options, [{ label: "Next", enabled: true }]);
  assert.deepEqual(reply.output, ["Original."]);
  const fresh = nativeEngineHost(engine, sources);
  fresh.parent.nav = null;
  const completed = fresh.host.resume(request(false), reply.continuation, 0);
  assert.equal(completed.status, "returned");
  assert.deepEqual(completed.output, []);
});

test(
  "native cancellation preserves an unrelated caller stack and removes transfer-owned stacks",
  { skip: !engine },
  () => {
    const sources = { native: "Original.\n*page_break Continue\n*return\n" };
    for (const replacement of [undefined, [], [{ name: "unrelated" }]]) {
      const first = nativeEngineHost(engine, sources);
      assert.equal(first.host.start(request(false)).status, "waiting");
      first.stats.choice_subscene_stack = replacement;
      first.host.cancel();
      assert.equal(first.stats.choice_subscene_stack, replacement);
      assert.equal(first.stats.scene, first.parent);
    }
    const transfer = nativeEngineHost(engine, sources, { choice_subscene_stack: [{ name: "old" }] });
    assert.equal(transfer.host.start(request(true)).status, "waiting");
    transfer.stats.choice_subscene_stack = [{ name: "owned transfer" }];
    transfer.host.cancel();
    assert.equal(Object.hasOwn(transfer.stats, "choice_subscene_stack"), false);
  },
);

test("an empty native host restores data while preserving callable navigation methods", { skip: !engine }, () => {
  const first = nativeEngineHost(engine, {}, { score: 1 });
  const method = () => "Original navigation method";
  first.parent.nav.ownedMethod = method;
  const host = createChoiceScriptHost(first.context.Scene, first.parent);
  const saved = host.snapshot();
  host.write("SCORE", 2);
  first.parent.nav.transient = "discard";
  host.restore(saved);
  assert.equal(host.read("score"), 1);
  assert.equal(first.parent.nav.ownedMethod, method);
  assert.equal(first.parent.nav.ownedMethod(), "Original navigation method");
  assert.equal(Object.hasOwn(first.parent.nav, "transient"), false);
});

test("ordinary native routines require return and nested scene calls retain their own stack", { skip: !engine }, () => {
  const missingReturn = nativeEngineHost(engine, { native: "Original unfinished routine.\n" });
  assert.throws(() => missingReturn.host.start(request(false)), /legacy subroutine reached the end without \*return/);
  const nested = nativeEngineHost(engine, {
    native: "*gosub_scene nested\nOriginal caller.\n*return\n",
    nested: "Original nested.\n*return\n",
  });
  const reply = nested.host.start(request(false));
  assert.equal(reply.status, "returned");
  assert.deepEqual(reply.output, ["Original nested. Original caller."]);
  assert.equal(nested.stats.scene, nested.parent);
});

test(
  "an active native bridge leaves unrelated engine scenes on their original execution route",
  { skip: !engine },
  () => {
    const first = nativeEngineHost(engine, { native: "Original.\n*page_break Continue\n*return\n" });
    const waiting = first.host.start(request(false));
    assert.equal(waiting.status, "waiting");
    const scene = new first.context.Scene("unrelated", {}, first.parent.nav);
    let loads = 0;
    scene.loadScene = function () {
      assert.equal(this, scene);
      loads++;
    };
    scene.execute();
    assert.equal(scene.executing, true);
    assert.equal(loads, 1);
    assert.equal(first.host.resume(request(false), waiting.continuation, 0).status, "returned");
  },
);
