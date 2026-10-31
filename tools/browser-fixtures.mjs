// Browser acceptance loads only these original local fixture routes.
const sources = new Map([
  ["browser", "/fixtures/browser.json"],
  ["browser-native", "/fixtures/browser-native.json"],
  ["browser-output", "/fixtures/browser-output.json"],
  ["browser-package", "/package/startup.txt"],
]);

export function fixtureSource(name) {
  const source = sources.get(name);
  if (!source) throw new Error("Unknown original browser fixture");
  return source;
}
