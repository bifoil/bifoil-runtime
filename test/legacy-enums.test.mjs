import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { boundaryType, fromLegacy, toLegacy } from "../src/legacy/values.mjs";

const program = JSON.parse(readFileSync(new URL("./fixtures/legacy-enum.json", import.meta.url), "utf8"));
const mood = { kind: "named", name: "main.Mood", args: [] };
const other = { kind: "named", name: "main.OtherMood", args: [] };
function host(answer = "Sad") {
  const state = { current: "Happy", answer: "Happy" };
  const calls = { starts: 0, resumes: 0 };
  return {
    state,
    calls,
    read(name) {
      return state[name.toLowerCase()];
    },
    write(name, value) {
      state[name.toLowerCase()] = value;
    },
    start(request) {
      calls.starts++;
      assert.deepEqual(request.args, ["Happy"]);
      return {
        status: "waiting",
        options: [{ label: "Choose Sad", enabled: true }],
        continuation: { requested: "Happy" },
      };
    },
    resume() {
      calls.resumes++;
      state.answer = answer;
      return { status: "returned", value: answer };
    },
    snapshot() {
      return { ...state };
    },
    restore(saved) {
      Object.assign(state, saved);
    },
  };
}

test("enum bridge snapshots retain typed values and native state without replay", () => {
  const original = host();
  const machine = new VM(program, null, { legacy: original });
  assert.equal(machine.run().status, "waiting");
  assert.equal(original.state.current, "Sad");
  const fresh = host();
  const restored = VM.restore(program, machine.save(), { legacy: fresh });
  assert.equal(fresh.calls.starts, 0);
  assert.equal(fresh.state.current, "Sad");
  assert.deepEqual(restored.choose(0).output, ["true|true|true"]);
  assert.equal(fresh.calls.starts, 0);
  assert.equal(fresh.calls.resumes, 1);
});

test("enum codecs check case names, nullable values, and nominal identity", () => {
  const machine = new VM(program, null, { legacy: host() });
  const encoded = fromLegacy("Happy", mood, machine);
  assert.equal(toLegacy(encoded, mood, machine), "Happy");
  const nullable = { kind: "nullable", inner: mood };
  assert.deepEqual(fromLegacy(null, nullable, machine), { kind: "null", value: null });
  assert.equal(toLegacy(fromLegacy("Sad", nullable, machine), nullable, machine), "Sad");
  assert.equal(toLegacy(fromLegacy(null, nullable, machine), nullable, machine), null);
  for (const raw of ["Missing", "happy", "main.Mood.Happy", 1, true, {}, ["Happy"]])
    assert.throws(() => fromLegacy(raw, mood, machine), /enum case/);
  assert.throws(() => toLegacy(fromLegacy("Happy", other, machine), mood, machine), /enum argument type mismatch/);
  assert.equal(boundaryType(mood, false, program.types), true);
  assert.equal(boundaryType({ kind: "named", name: "main.Record", args: [] }, false, program.types), false);
  assert.equal(boundaryType({ ...mood, args: [{ kind: "int" }] }, false, program.types), false);
  const sharedDefinition = { [mood.name]: program.types[mood.name], [other.name]: program.types[mood.name] };
  assert.equal(boundaryType(mood, false, sharedDefinition), true);
  assert.equal(boundaryType(other, false, sharedDefinition), false);
});

test("an invalid native enum result fails at its Bifoil span without undoing native effects", () => {
  const native = host("Missing");
  const machine = new VM(program, null, { legacy: native });
  assert.equal(machine.run().status, "waiting");
  assert.throws(() => machine.choose(0), /src\/main\.bfl:.*legacy value is not an enum case/);
  assert.equal(native.state.current, "Sad");
  assert.equal(native.state.answer, "Missing");
});

test("generic legacy interfaces remain invalid even when their parameter is unused", () => {
  const invalid = structuredClone(program);
  invalid.functions["main.ask"].signature.generics = [{ name: "T", variance: 0, bounds: [] }];
  assert.throws(() => new VM(invalid, null, { legacy: host() }), /invalid legacy call interface/);
});
