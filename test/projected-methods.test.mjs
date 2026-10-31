import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeMembers } from "../src/members.mjs";

const named = (name, ...args) => ({ kind: "named", name, args });
const int = { kind: "int" };
const star = { kind: "star" };
const nullable = (inner) => ({ kind: "nullable", inner });

test("nominal copies retain hidden owner arguments and honor explicit nested projections", () => {
  const source = named("Box", int, named("List", int));
  const receiver = { kind: "data", ref: 0, type: source };
  const machine = {
    program: {
      types: {
        Box: {
          parameters: [{ name: "T" }, { name: "U" }],
          methods: { copy: [{ id: "test.Box.copy" }] },
        },
      },
    },
    object: () => ({ type: source, fields: {} }),
    captureReceiver: (value) => {
      assert.equal(value, receiver);
      return 0;
    },
  };
  for (const [requested, expected] of [
    [
      [star, star],
      [int, named("List", int)],
    ],
    [
      [star, named("List", star)],
      [int, named("List", star)],
    ],
    [
      [nullable({ kind: "any" }), star],
      [nullable({ kind: "any" }), named("List", int)],
    ],
    [
      [star, nullable(named("List", star))],
      [int, nullable(named("List", star))],
    ],
  ]) {
    const exposed = { kind: "function", params: [], result: named("Box", ...requested), suspend: false };
    const value = RuntimeMembers.prototype.getMember.call(machine, receiver, "copy", exposed, "test.Box.copy");
    assert.deepEqual(value.typeArgs, { T: expected[0], U: expected[1] });
    assert.equal(value.receiver, 0);
    assert.equal(value.type, exposed);
    assert.deepEqual(source.args, [int, named("List", int)]);
  }
});
