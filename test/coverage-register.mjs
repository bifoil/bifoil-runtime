/** Instrument source as it loads; never rewrite the checked-out files. */
import { registerHooks } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import instrument from "istanbul-lib-instrument";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { includes } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).bifoilQuality;
const prefixes = includes.map((pattern) => pattern.slice(0, -2));
const observer = instrument.createInstrumenter({ esModules: true, compact: false });
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (!url.startsWith("file:") || loaded.format !== "module") return loaded;
    const name = relative(root, fileURLToPath(url)).replaceAll("\\", "/");
    if (!name.endsWith(".mjs") || !prefixes.some((prefix) => name.startsWith(prefix))) return loaded;
    return { ...loaded, source: observer.instrumentSync(String(loaded.source), name) };
  },
});
process.once("exit", () => {
  const directory = process.env.BIFOIL_ISTANBUL_DIRECTORY;
  if (!directory) throw new Error("Coverage output directory was not provided");
  writeFileSync(
    join(directory, process.pid + "-" + randomUUID() + ".json"),
    JSON.stringify(globalThis.__coverage__ ?? {}),
  );
});
