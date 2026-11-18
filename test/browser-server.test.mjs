import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import * as filesystem from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { browserOptions, startBrowserServer } from "../tools/serve-browser.mjs";
import { mockModule } from "./module-mocks.mjs";

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

test("the default browser port keeps non-module entries and invalid directories outside its route inventory", async (t) => {
  const fixture = files(t);
  mockModule(t, "node:fs/promises", {
    exports: {
      ...filesystem,
      readdir: async (directory, options) => {
        const entries = await filesystem.readdir(directory, options);
        if (basename(String(directory)) !== "src") return entries;
        return [
          ...entries,
          { name: "private-data.txt", isDirectory: () => false, isFile: () => true },
          { name: "private_files", isDirectory: () => true, isFile: () => false },
        ];
      },
    },
  });
  const host = await import(new URL("../tools/serve-browser.mjs?inventory-contract", import.meta.url).href);
  const server = await host.startBrowserServer({ engine: fixture.engine });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  assert.equal(server.address().port, 8765);
  const base = "http://127.0.0.1:8765";
  assert.equal((await fetch(base + "/runtime/src/vm.mjs")).status, 200);
  assert.equal((await fetch(base + "/runtime/src/private-data.txt")).status, 404);
  assert.equal((await fetch(base + "/runtime/src/private_files/secret.mjs")).status, 404);
});

test(
  "the browser CLI remains responsive to an unknown command and closes on explicit stop",
  {
    timeout: process.env.BIFOIL_ISTANBUL_DIRECTORY ? 60000 : 10000,
  },
  async (t) => {
    const fixture = files(t),
      probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const observer = process.env.BIFOIL_ISTANBUL_DIRECTORY
      ? ["--import", fileURLToPath(new URL("./coverage-register.mjs", import.meta.url))]
      : [];
    const child = spawn(
      process.execPath,
      [
        ...observer,
        "tools/serve-browser.mjs",
        "--engine-dir",
        fixture.engine,
        "--package-dir",
        fixture.packageDirectory,
        "--port",
        String(port),
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    let errors = "";
    child.stderr.on("data", (data) => {
      errors += data;
    });
    const completed = once(child, "exit"),
      lines = createInterface({ input: child.stdout });
    t.after(() => lines.close());
    const ready = await Promise.race([
      once(lines, "line").then(([line]) => line),
      completed.then(([code]) => {
        throw new Error("Browser CLI exited before readiness: " + code + ": " + errors);
      }),
    ]);
    assert.equal(ready, "Browser acceptance: http://127.0.0.1:" + port);
    child.stdin.write("status\n");
    assert.equal((await fetch("http://127.0.0.1:" + port + "/package/startup.txt")).status, 200);
    child.stdin.end("stop\n");
    const [code, signal] = await completed;
    assert.equal(code, 0, errors);
    assert.equal(signal, null);
  },
);
