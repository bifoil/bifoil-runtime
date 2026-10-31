import test from "node:test";
import assert from "node:assert/strict";
import { nonNull, nullable, reifyCollectionCopy, sameType, subtype, substitute, typeValid } from "../src/types.mjs";

test("non-null generic refinement preserves identity while removing null after substitution", () => {
  const parameter = { kind: "parameter", name: "T" };
  const refined = nonNull(parameter);
  assert.equal(sameType(parameter, refined), false);
  assert.equal(subtype(refined, parameter), true);
  assert.equal(subtype(parameter, refined), false);
  assert.equal(subtype(refined, { kind: "any" }), true);
  assert.equal(subtype(parameter, { kind: "any" }), false);
  assert.deepEqual(substitute(refined, { T: nullable({ kind: "string" }) }), { kind: "string" });
  assert.deepEqual(substitute(refined, { T: { kind: "null" } }), { kind: "nothing" });
  assert.deepEqual(nullable(refined), nullable(parameter));
  assert.equal(typeValid(refined), true);
  assert.equal(typeValid({ ...parameter, nonnull: "yes" }), false);
  assert.equal(sameType(parameter, { ...parameter, nonnull: false }), true);
  assert.equal(parameter.nonnull, undefined);
});

test("collection copies preserve nested projected arguments without undoing requested conversions", () => {
  const int = { kind: "int" },
    float = { kind: "float" },
    star = { kind: "star" };
  const named = (name, ...args) => ({ kind: "named", name, args });
  const definitions = {
    Success: { parameters: [{ name: "T" }], parent: named("Outcome", { kind: "parameter", name: "T" }) },
  };
  const copy = (target, source) =>
    reifyCollectionCopy(named("List", target), named("MutableList", source), definitions);
  assert.deepEqual(copy(named("List", star), named("List", int)), named("List", named("List", int)));
  assert.deepEqual(copy(named("Outcome", star), named("Success", int)), named("List", named("Outcome", int)));
  assert.deepEqual(
    copy(nullable(named("List", star)), nullable(named("List", int))),
    named("List", nullable(named("List", int))),
  );
  assert.deepEqual(copy(named("Map", star, float), named("Map", int, int)), named("List", named("Map", int, float)));
  const callback = (result) => ({ kind: "function", params: [], result, suspend: false });
  assert.deepEqual(
    copy(callback(named("List", star)), callback(named("List", int))),
    named("List", callback(named("List", int))),
  );
  assert.deepEqual(copy(named("List", float), named("List", int)), named("List", named("List", float)));
});

test("cyclic nominal parents fail instead of looping during subtype and projection checks", () => {
  const named = (name, ...args) => ({ kind: "named", name, args });
  const definitions = { A: { parent: "B" }, B: { parent: "A" } };
  assert.throws(() => subtype(named("A"), named("C"), definitions), /cyclic nominal parent/);
  assert.throws(
    () =>
      reifyCollectionCopy(named("List", named("C", { kind: "star" })), named("MutableList", named("A")), definitions),
    /cyclic nominal parent/,
  );
});

test("nested projections remain the requested element types in mutable copies and invariant map keys", () => {
  const named = (name, ...args) => ({ kind: "named", name, args });
  const int = { kind: "int" },
    star = { kind: "star" };
  const target = named("MutableList", named("List", star));
  assert.deepEqual(reifyCollectionCopy(target, named("List", named("List", int))), target);
  const map = named("Map", named("Box", star), star);
  assert.deepEqual(
    reifyCollectionCopy(map, named("MutableMap", named("Box", int), int)),
    named("Map", named("Box", star), int),
  );
});
