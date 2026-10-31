import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { nativeEngineHost } from "../src/legacy/node-host.mjs";

const engine = process.env.CHOICESCRIPT_ENGINE;
const program = JSON.parse(readFileSync(new URL("./fixtures/legacy.json", import.meta.url), "utf8"));
function fresh(initial = {}) {
  return nativeEngineHost(engine, program.legacy_sources, initial);
}
test("native bridge restores into fresh engines without replaying native preparation", { skip: !engine }, () => {
  const first = fresh({ calls: 0, answer: 0 }),
    machine = new VM(program, null, { legacy: first.host });
  assert.deepEqual(machine.run().options, [{ label: "Take 2", enabled: true }]);
  const second = fresh(),
    restored = VM.restore(program, machine.save(), { legacy: second.host });
  assert.equal(second.stats.calls, 2);
  assert.deepEqual(restored.choose(0).options, [{ label: "Finish 3", enabled: true }]);
  const third = fresh(),
    completed = VM.restore(program, restored.save(), { legacy: third.host });
  assert.deepEqual(completed.choose(0).output, ["9|3"]);
  assert.equal(third.stats.calls, 3);
});

test("number input agrees with the unchanged native callback and retains prepared bounds", { skip: !engine }, () => {
  const request = { target: { scene: "native", label: null, result: "answer" }, suspend: true, args: [] };
  const sources = { native: "*set calls + 1\n*input_number answer 1 9\n*return\n" };
  const first = nativeEngineHost(engine, sources, { calls: 0, answer: 0 });
  let reply = first.host.start(request),
    callback;
  const context = first.context,
    stats = { answer: 0 };
  const native = new context.Scene("native", stats, first.parent.nav);
  native.paragraph = () => {};
  native.resetPage = () => {};
  context.printInput = (target, options, respond) => {
    callback = respond;
  };
  context.safeCall = (receiver, action) => action.call(receiver);
  let nativeFeedback;
  context.asyncAlert = (message) => {
    nativeFeedback = message;
  };
  native.input_number("answer 1 9");
  for (const response of ["x", "2.5", "0", "10", "7"]) {
    nativeFeedback = null;
    callback(response);
    const next = nativeEngineHost(engine, sources);
    reply = next.host.resume(request, JSON.parse(JSON.stringify(reply.continuation)), response);
    assert.equal(next.stats.calls, 1);
    if (nativeFeedback) {
      assert.equal(reply.status, "waiting");
      assert.equal(reply.input.feedback, nativeFeedback);
    } else {
      assert.equal(reply.status, "returned");
      assert.equal(reply.value, stats.answer);
    }
  }
});

test("ordinary bridges reject native transfers before their destination executes", { skip: !engine }, () => {
  const { host, stats } = nativeEngineHost(
    engine,
    {
      native: "*goto_scene destination\n",
      destination: "*set calls + 1\n*ending\n",
    },
    { calls: 0 },
  );
  assert.throws(
    () => host.start({ target: { scene: "native", label: null, result: null }, suspend: true, args: [] }),
    /explicit transfer bridge/,
  );
  assert.equal(stats.calls, 0);
});

test(
  "plain enums cross the unchanged engine and retain their nominal values after restoration",
  { skip: !engine },
  () => {
    const enums = JSON.parse(readFileSync(new URL("./fixtures/legacy-enum.json", import.meta.url), "utf8"));
    assert.equal(
      enums.legacy_sources.questions,
      readFileSync(new URL("./fixtures/legacy-enum-native.txt", import.meta.url), "utf8"),
    );
    const first = nativeEngineHost(engine, enums.legacy_sources, { current: "Happy", answer: "Happy" });
    const machine = new VM(enums, null, { legacy: first.host });
    assert.deepEqual(machine.run().options, [{ label: "Choose Sad", enabled: true }]);
    const second = nativeEngineHost(engine, enums.legacy_sources);
    let starts = 0;
    const start = second.host.start;
    second.host.start = (request) => {
      starts++;
      return start(request);
    };
    const restored = VM.restore(enums, machine.save(), { legacy: second.host });
    assert.equal(second.stats.current, "Sad");
    assert.deepEqual(restored.choose(0).output, ["true|true|true"]);
    assert.equal(second.stats.answer, "Sad");
    assert.equal(starts, 0);
  },
);
