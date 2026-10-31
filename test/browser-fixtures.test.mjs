import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureSource } from "../tools/browser-fixtures.mjs";

test("browser acceptance resolves each supported story to its fixed local route", () => {
  assert.equal(fixtureSource("browser"), "/fixtures/browser.json");
  assert.equal(fixtureSource("browser-native"), "/fixtures/browser-native.json");
  assert.equal(fixtureSource("browser-output"), "/fixtures/browser-output.json");
  assert.equal(fixtureSource("browser-package"), "/package/startup.txt");
});

test("browser acceptance rejects traversal, foreign origins, inherited names and unknown fixtures", () => {
  for (const value of [
    "../engine/util.js",
    "../../package/startup.txt",
    "https://example.invalid/fixture",
    "//example.invalid/fixture",
    "browser?next=elsewhere",
    "__proto__",
    "constructor",
    "unknown",
    "",
    null,
    undefined,
  ]) {
    assert.throws(() => fixtureSource(value), /Unknown original browser fixture/);
  }
});
