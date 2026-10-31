import { nativeEngineHost } from "../src/legacy/node-host.mjs";
import { readFileSync } from "node:fs";
import { VM } from "../src/vm.mjs";
import { readCompiledProgram } from "../src/node-program.mjs";
const program = await readCompiledProgram(process.argv[2]);
const config = JSON.parse(readFileSync(process.argv[3], "utf8"));
let machine,
  result,
  error = null;
const options = [];
function machineOptions(initial = {}) {
  const required = Object.keys(program.legacy_globals ?? {}).length || Object.keys(program.legacy_sources ?? {}).length;
  if (!required) return { quantum: config.quantum };
  if (!config.native_engine) throw new Error("legacy conformance requires an explicit --engine path");
  return {
    quantum: config.quantum,
    legacy: nativeEngineHost(config.native_engine, program.legacy_sources, initial).host,
  };
}
try {
  machine = new VM(program, null, machineOptions(config.legacy_stats ?? {}));
  result = machine.run();
  let index = 0;
  while (result.status !== "done") {
    if (result.status === "running") {
      result = machine.run();
      continue;
    }
    options.push(result.options.map((o) => o.label));
    if (index >= (config.choices ?? []).length) throw new Error("case needs a selection");
    machine = VM.restore(program, machine.save(), machineOptions());
    const response = config.choices[index++];
    result = result.input ? machine.submit(response) : machine.choose(response);
  }
  if (index !== (config.choices ?? []).length) throw new Error("unused case selections");
} catch (failure) {
  error = failure.message;
}
console.log(JSON.stringify({ output: machine?.state.transcript ?? [], options, error }));
