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

test("function and scene type descriptors preserve arity, parameter identity and checked variance", () => {
  const int = { kind: "int" },
    float = { kind: "float" },
    any = { kind: "any" },
    star = { kind: "star" };
  const scene = (...params) => ({ kind: "scene", params });
  const callable = (...params) => ({ kind: "function", params, result: int, suspend: false });
  assert.deepEqual(nonNull(star), any);
  assert.equal(sameType(scene(int), scene(float)), false);
  assert.equal(sameType(scene(int), scene()), false);
  assert.equal(sameType(callable(int), callable(float)), false);
  assert.equal(subtype(scene(int), callable(int)), false);
  assert.equal(typeValid(scene(int)), true);
  for (const invalid of [
    { kind: "scene", params: null },
    scene({ kind: "unknown" }),
    { kind: "parameter", name: 1 },
    { ...callable(), vararg: true },
    { ...callable(int), params: [null] },
    { ...callable(), result: null },
  ])
    assert.equal(typeValid(invalid), false);
  const parameter = { kind: "parameter", name: "T" };
  assert.deepEqual(substitute(scene(parameter), { T: int }), scene(int));
  assert.throws(() => substitute(parameter, {}), /unresolved runtime type parameter/);
  const named = (name, ...args) => ({ kind: "named", name, args });
  const definitions = { Consumer: { parameters: [{ name: "T", variance: -1 }] } };
  assert.equal(subtype(named("Consumer", any), named("Consumer", int), definitions), true);
  assert.equal(subtype(named("Consumer", int), named("Consumer", any), definitions), false);
  assert.equal(subtype(named("Consumer", int), named("Consumer"), definitions), false);
});

test("projected copies cannot create an unrelated nominal view or change a callable's arity", () => {
  const int = { kind: "int" },
    star = { kind: "star" };
  const named = (name, ...args) => ({ kind: "named", name, args });
  const copy = (requested, actual) => reifyCollectionCopy(named("List", requested), named("List", actual));
  assert.deepEqual(copy(named("Box", star), named("Other", int)), named("List", named("Box", star)));
  const callable = (...params) => ({ kind: "function", params, result: int, suspend: false });
  assert.deepEqual(copy(callable(), callable(int)), named("List", callable()));
  const scene = (...params) => ({ kind: "scene", params });
  assert.deepEqual(copy(scene(star), scene(int)), named("List", scene(star)));
});
