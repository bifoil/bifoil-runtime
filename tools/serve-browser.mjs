// Serve only the acceptance page, runtime modules, original fixture, and explicitly
// supplied engine assets. This development host listens on the loopback interface.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtime = fileURLToPath(new URL("../", import.meta.url));
const arguments_ = process.argv.slice(2);
let engine,
  packageDirectory,
  port = 8765;
while (arguments_.length) {
  const option = arguments_.shift(),
    value = arguments_.shift();
  if (option === "--engine-dir" && value) engine = path.resolve(value);
  else if (option === "--package-dir" && value) packageDirectory = path.resolve(value);
  else if (option === "--port" && /^\d+$/.test(value)) port = Number(value);
  else throw new Error("Usage: node tools/serve-browser.mjs --engine-dir PATH [--package-dir PATH] [--port PORT]");
}
if (!engine || port < 1 || port > 65535) throw new Error("An engine directory and valid port are required");
const assets = new Set(["persist.js", "alertify.min.js", "util.js", "ui.js", "scene.js", "navigator.js", "style.css"]);
for (const name of assets)
  if (!(await stat(path.join(engine, name))).isFile()) throw new Error("Missing engine asset " + name);

if (packageDirectory && !(await stat(path.join(packageDirectory, "startup.txt"))).isFile())
  throw new Error("Package acceptance requires startup.txt in --package-dir");

function requestedFile(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  if (pathname === "/") return path.join(runtime, "tools/browser-host.html");
  if (packageDirectory && /^\/package\/(?:startup|bifoil_code_[0-9a-f]{64})\.txt$/.test(pathname))
    return path.join(packageDirectory, pathname.slice(9));
  if (["/browser-host.mjs", "/browser-save.mjs"].includes(pathname))
    return path.join(runtime, "tools", pathname.slice(1));
  if (["/fixtures/browser.json", "/fixtures/browser-native.json", "/fixtures/browser-output.json"].includes(pathname))
    return path.join(runtime, "test", pathname.slice(1));
  if (pathname === "/fixtures/output-marker.svg") return path.join(runtime, "test/fixtures/output-marker.svg");
  if (pathname.startsWith("/engine/") && assets.has(pathname.slice(8))) return path.join(engine, pathname.slice(8));
  if (/^\/runtime\/src\/(?:[a-z-]+\/)*[a-z-]+\.mjs$/.test(pathname)) return path.join(runtime, pathname.slice(9));
  return null;
}
const server = createServer(async (request, response) => {
  try {
    const file = requestedFile(request.url);
    if (!file || request.method !== "GET") {
      response.writeHead(404);
      response.end();
      return;
    }
    let content = await readFile(file);
    if (file === path.join(runtime, "tools/browser-host.html"))
      content = content
        .toString("utf8")
        .replace(
          "<!-- package-fixture -->",
          packageDirectory ? '<option value="browser-package">Compiled code package</option>' : "",
        );
    const extension = path.extname(file);
    response.writeHead(200, {
      "Content-Type":
        extension === ".html"
          ? "text/html; charset=utf-8"
          : extension === ".css"
            ? "text/css; charset=utf-8"
            : extension === ".svg"
              ? "image/svg+xml"
              : extension === ".txt"
                ? "text/plain; charset=utf-8"
                : extension === ".json"
                  ? "application/json"
                  : "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
server.listen(port, "127.0.0.1", () => console.log("Browser acceptance: http://127.0.0.1:" + port));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (command) => {
  if (command.trim() === "stop") server.close(() => process.exit(0));
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
