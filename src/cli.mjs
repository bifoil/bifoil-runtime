import { setImmediate as yieldExecution } from "node:timers/promises";
import { nativeEngineHost } from "./legacy/node-host.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VM } from "./vm.mjs";
import { readCompiledProgram } from "./node-program.mjs";

/** Validate flags after the selected program has been read, retaining diagnostic order. */
function cliOptions(args) {
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
  return options;
}

function cliMachine(program, options) {
  const requiresLegacy =
    Object.keys(program.legacy_globals ?? {}).length || Object.keys(program.legacy_sources ?? {}).length;
  if (requiresLegacy && !options["--engine"]) throw new Error("legacy execution requires --engine SCENE.js");
  const initial = options["--legacy-stats"] ? JSON.parse(readFileSync(options["--legacy-stats"], "utf8")) : {};
  const legacy = requiresLegacy ? nativeEngineHost(options["--engine"], program.legacy_sources, initial).host : null;
  return options["--load"]
    ? VM.restore(program, readFileSync(options["--load"], "utf8"), { legacy })
    : new VM(program, null, { legacy });
}

/** Each interaction resumes the same VM before another input is requested. */
async function runTerminalSession(machine, options, terminal, print) {
  let result = machine.run();
  while (true) {
    for (const paragraph of result.output) print(paragraph + "\n");
    if (result.status === "done") break;
    if (result.status === "loading") {
      await result.ready;
      result = machine.run();
      continue;
    }
    if (result.status === "running") {
      await yieldExecution();
      result = machine.run();
      continue;
    }
    result.options.forEach((o, i) => print(i + 1 + ". " + o.label + (o.enabled ? "" : " [disabled]")));
    if (options["--save"]) {
      writeFileSync(options["--save"], machine.save());
      print("Saved input checkpoint.");
      break;
    }
    if (result.input?.feedback) print(result.input.feedback);
    const response = await terminal.question("> ");
    result = result.input ? machine.submit(response) : machine.choose(Number(response) - 1);
  }
}

/** Run one terminal session; return its exit status without terminating the host. */
export async function runCli(
  arguments_,
  { input = stdin, output = stdout, print = console.log, errorOutput = console.error } = {},
) {
  const args = [...arguments_];
  const source = args.shift();
  if (!source) {
    errorOutput(
      "node src/cli.mjs STARTUP.txt [--load SAVE.json] [--save SAVE.json] [--engine SCENE.js] [--legacy-stats STATE.json]",
    );
    return 1;
  }
  let machine;
  try {
    const program = await readCompiledProgram(source);
    const options = cliOptions(args);
    machine = cliMachine(program, options);
    const terminal = createInterface({ input, output });
    try {
      await runTerminalSession(machine, options, terminal, print);
    } finally {
      terminal.close();
    }
  } catch (error) {
    for (const paragraph of machine?.drainOutput() ?? []) print(paragraph + "\n");
    errorOutput(error.message);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
