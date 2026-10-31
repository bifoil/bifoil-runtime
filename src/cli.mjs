import { setImmediate as yieldExecution } from "node:timers/promises";
import { nativeEngineHost } from "./legacy/node-host.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { VM } from "./vm.mjs";
import { readCompiledProgram } from "./node-program.mjs";

const args = process.argv.slice(2);
const source = args.shift();
if (!source) {
  console.error(
    "node src/cli.mjs STARTUP.txt [--load SAVE.json] [--save SAVE.json] [--engine SCENE.js] [--legacy-stats STATE.json]",
  );
  process.exit(1);
}
let machine;
try {
  const program = await readCompiledProgram(source);
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (
      !["--load", "--save", "--engine", "--legacy-stats"].includes(key) ||
      !args.length ||
      Object.hasOwn(options, key)
    )
      throw new Error("invalid CLI option");
    options[key] = args.shift();
  }
  const requiresLegacy =
    Object.keys(program.legacy_globals ?? {}).length || Object.keys(program.legacy_sources ?? {}).length;
  if (requiresLegacy && !options["--engine"]) throw new Error("legacy execution requires --engine SCENE.js");
  const initial = options["--legacy-stats"] ? JSON.parse(readFileSync(options["--legacy-stats"], "utf8")) : {};
  const legacy = requiresLegacy ? nativeEngineHost(options["--engine"], program.legacy_sources, initial).host : null;
  machine = options["--load"]
    ? VM.restore(program, readFileSync(options["--load"], "utf8"), { legacy })
    : new VM(program, null, { legacy });
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    let result = machine.run();
    while (true) {
      for (const paragraph of result.output) console.log(paragraph + "\n");
      if (result.status === "done") break;
      if (result.status === "running") {
        await yieldExecution();
        result = machine.run();
        continue;
      }
      result.options.forEach((o, i) => console.log(i + 1 + ". " + o.label + (o.enabled ? "" : " [disabled]")));
      if (options["--save"]) {
        writeFileSync(options["--save"], machine.save());
        console.log("Saved input checkpoint.");
        break;
      }
      if (result.input?.feedback) console.log(result.input.feedback);
      const response = await terminal.question("> ");
      result = result.input ? machine.submit(response) : machine.choose(Number(response) - 1);
    }
  } finally {
    terminal.close();
  }
} catch (error) {
  for (const paragraph of machine?.drainOutput() ?? []) console.log(paragraph + "\n");
  console.error(error.message);
  process.exitCode = 1;
}
