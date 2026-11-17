// Loopback development host for original fixtures and explicitly supplied engine assets.
import { createServer } from "node:http";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtime = fileURLToPath(new URL("../", import.meta.url));
const assets = ["persist.js", "alertify.min.js", "util.js", "ui.js", "scene.js", "navigator.js", "style.css"];
const usage = "Usage: node tools/serve-browser.mjs --engine-dir PATH [--package-dir PATH] [--port PORT]";

export function browserOptions(arguments_) {
  const args = [...arguments_];
  const options = { port: 8765 };
  while (args.length) {
    const option = args.shift(),
      value = args.shift();
    if (option === "--engine-dir" && value) options.engine = path.resolve(value);
    else if (option === "--package-dir" && value) options.packageDirectory = path.resolve(value);
    else if (option === "--port" && /^\d+$/.test(value)) options.port = Number(value);
    else throw new Error(usage);
  }
  if (!options.engine || options.port < 1 || options.port > 65535)
    throw new Error("An engine directory and valid port are required");
  return options;
}

function contained(root, file) {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

/** Build a closed route inventory from trusted files, never from request path fragments. */
async function routeInventory(engine, packageDirectory) {
  const routes = new Map();
  async function add(route, root, name) {
    const directory = await realpath(root),
      file = await realpath(path.join(directory, name));
    if (!contained(directory, file) || !(await stat(file)).isFile())
      throw new Error("Acceptance asset must be a regular file within its selected directory");
    routes.set(route, { directory, file });
  }
  await add("/", runtime, "tools/browser-host.html");
  for (const name of ["browser-host.mjs", "browser-save.mjs", "browser-fixtures.mjs"])
    await add("/" + name, path.join(runtime, "tools"), name);
  for (const name of ["browser.json", "browser-native.json", "browser-output.json", "output-marker.svg"])
    await add("/fixtures/" + name, path.join(runtime, "test/fixtures"), name);
  for (const name of assets) await add("/engine/" + name, engine, name);
  async function modules(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[a-z-]+$/.test(entry.name))
        await modules(path.join(directory, entry.name), prefix + entry.name + "/");
      else if (entry.isFile() && /^[a-z-]+\.mjs$/.test(entry.name))
        await add("/runtime/src/" + prefix + entry.name, path.join(runtime, "src"), prefix + entry.name);
    }
  }
  await modules(path.join(runtime, "src"));
  if (packageDirectory) {
    await add("/package/startup.txt", packageDirectory, "startup.txt");
    for (const name of await readdir(packageDirectory))
      if (/^bifoil_code_[0-9a-f]{64}\.txt$/.test(name)) await add("/package/" + name, packageDirectory, name);
  }
  return routes;
}

function contentType(file) {
  const types = {
    ".html": "text/html",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".json": "application/json",
  };
  return (types[path.extname(file)] ?? "text/javascript") + "; charset=utf-8";
}

/** Port zero is available to tests; command-line ports remain explicit and nonzero. */
export async function startBrowserServer({ engine, packageDirectory, port = 8765 }) {
  const routes = await routeInventory(engine, packageDirectory);
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const route = routes.get(pathname);
      if (!route || request.method !== "GET") {
        response.writeHead(404).end();
        return;
      }
      // Refuse a file replaced with an escaping symlink after the inventory was built.
      if (!contained(route.directory, await realpath(route.file))) throw new Error("Asset moved outside its directory");
      let content = await readFile(route.file);
      if (pathname === "/")
        content = content
          .toString("utf8")
          .replace(
            "<!-- package-fixture -->",
            packageDirectory ? '<option value="browser-package">Compiled code package</option>' : "",
          );
      response.writeHead(200, { "Content-Type": contentType(route.file), "Cache-Control": "no-store" });
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startBrowserServer(browserOptions(process.argv.slice(2)));
  console.log("Browser acceptance: http://127.0.0.1:" + server.address().port);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (command) => {
    if (command.trim() === "stop") server.close(() => process.exit(0));
  });
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}
