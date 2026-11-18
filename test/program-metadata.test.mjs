import test from "node:test";
import assert from "node:assert/strict";
import { sameMetadata, summarizeFunction } from "../src/code-metadata.mjs";
import { legacyInstructions, packageCodeStats } from "../src/program-code.mjs";
import { signatureType, nullable, subtype } from "../src/types.mjs";

test("metadata comparison rejects changed object keys even when object sizes match", () => {
  assert.equal(sameMetadata({ part: { name: "original" } }, { part: { other: "original" } }), false);
  assert.equal(sameMetadata({ part: { name: "original" } }, { part: { name: "original" } }), true);
});

test("inline programs retain their legacy instructions without package residency statistics", () => {
  const code = [{ op: "legacy_call", target: { scene: "original" } }];
  const program = { functions: { original: { code } } };
  assert.equal(legacyInstructions(program, "original"), code);
  assert.equal(packageCodeStats(program), null);
});

test("zero-parameter callable summaries preserve the declared nonvariadic signature", () => {
  const signature = { id: "original", params: [], result: { kind: "unit" }, suspend: false, scene: false };
  assert.deepEqual(signatureType(signature), {
    kind: "function",
    params: [],
    result: { kind: "unit" },
    suspend: false,
  });
  const summary = summarizeFunction({ signature, init: false, code: [{ op: "return" }] }, "original");
  assert.equal(summary.local, false);
  assert.deepEqual(summary.captures, []);
  assert.deepEqual(nullable({ kind: "null" }), { kind: "null" });
  assert.equal(subtype({ kind: "null" }, { kind: "int" }), false);
  assert.equal(
    subtype({ kind: "named", name: "IntRange", args: [] }, { kind: "named", name: "IntProgression", args: [] }),
    true,
  );
});
