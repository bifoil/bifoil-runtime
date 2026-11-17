import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserOptions, startBrowserServer } from "../tools/serve-browser.mjs";

function files(t) {
  const root = mkdtempSync(join(tmpdir(), "bifoil-browser-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const engine = join(root, "engine"),
    packageDirectory = join(root, "package");
  mkdirSync(engine);
  mkdirSync(packageDirectory);
  for (const name of ["persist.js", "alertify.min.js", "util.js", "ui.js", "scene.js", "navigator.js", "style.css"])
    writeFileSync(join(engine, name), name);
  writeFileSync(join(packageDirectory, "startup.txt"), "*title Original");
  const code = "bifoil_code_" + "a".repeat(64) + ".txt";
  writeFileSync(join(packageDirectory, code), "compiled code");
  writeFileSync(join(root, "private.txt"), "must never be served");
  return { root, engine, packageDirectory, code, port: 0 };
}
async function serving(t, options) {
  const server = await startBrowserServer(options);
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return "http://127.0.0.1:" + server.address().port;
}

test("browser host parses explicit directories and rejects invalid ports or incomplete arguments", () => {
  assert.deepEqual(browserOptions(["--engine-dir", "engine", "--package-dir", "code", "--port", "1234"]), {
    engine: resolve("engine"),
    packageDirectory: resolve("code"),
    port: 1234,
  });
  assert.equal(browserOptions(["--engine-dir", "engine"]).port, 8765);
  for (const args of [
    [],
    ["--engine-dir"],
    ["--unknown", "x"],
    ["--engine-dir", "x", "--port", "0"],
    ["--engine-dir", "x", "--port", "65536"],
    ["--engine-dir", "x", "--port", "abc"],
  ])
    assert.throws(() => browserOptions(args), /Usage|valid port/);
});
test("browser host serves only inventoried original fixtures, code and engine assets", async (t) => {
  const fixture = files(t),
    base = await serving(t, fixture);
  for (const [route, mime] of [
    ["/", "text/html"],
    ["/engine/style.css", "text/css"],
    ["/fixtures/output-marker.svg", "image/svg+xml"],
    ["/fixtures/browser.json", "application/json"],
    ["/runtime/src/vm.mjs", "text/javascript"],
    ["/runtime/src/legacy/node-host.mjs", "text/javascript"],
    ["/browser-save.mjs", "text/javascript"],
    ["/package/startup.txt", "text/plain"],
    ["/package/" + fixture.code, "text/plain"],
  ]) {
    const result = await fetch(base + route);
    assert.equal(result.status, 200, route);
    assert.ok(result.headers.get("content-type").startsWith(mime));
    assert.equal(result.headers.get("cache-control"), "no-store");
    if (route === "/") assert.match(await result.text(), /Compiled code package/);
    else assert.ok((await result.text()).length > 0);
  }
  for (const route of [
    "/private.txt",
    "/engine/../private.txt",
    "/engine/%2f..%2fprivate.txt",
    "/runtime/src/%5c..%5cprivate.txt",
    "/%invalid",
    "/package/other.txt",
  ])
    assert.equal((await fetch(base + route)).status, 404, route);
  assert.equal((await fetch(base + "/", { method: "POST" })).status, 404);
});
test("browser host without a package omits package controls and requires all assets", async (t) => {
  const fixture = files(t),
    base = await serving(t, { engine: fixture.engine, port: 0 });
  assert.doesNotMatch(await (await fetch(base)).text(), /Compiled code package/);
  assert.equal((await fetch(base + "/package/startup.txt")).status, 404);
  rmSync(join(fixture.engine, "scene.js"));
  await assert.rejects(startBrowserServer(fixture), /ENOENT/);
});
test("browser host refuses symlinks escaping selected asset roots before and after startup", async (t) => {
  const fixture = files(t),
    scene = join(fixture.engine, "scene.js"),
    outside = join(fixture.root, "private.txt");
  const base = await serving(t, fixture);
  rmSync(scene);
  symlinkSync(outside, scene);
  assert.equal((await fetch(base + "/engine/scene.js")).status, 404);
  await assert.rejects(startBrowserServer(fixture), /within its selected directory/);
});
