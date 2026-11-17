// Private code providers preserve stable declarations while bodies may be evicted.
// Only package loading registers providers; ordinary program JSON cannot opt out
// of instruction validation by carrying a field with a privileged name.
const providers = new WeakMap();

export function registerProgramCode(program, provider) {
  providers.set(program, provider);
}

export function programCode(program) {
  return providers.get(program);
}

export function functionMetadata(program, id) {
  return providers.get(program)?.headers[id];
}

export function functionLength(program, id) {
  return functionMetadata(program, id)?.instructions ?? program.functions[id]?.code.length;
}

export function continuationInstruction(program, id, pc) {
  const metadata = functionMetadata(program, id);
  return metadata ? metadata.continuations[pc] : program.functions[id]?.code[pc];
}

export function stackMarkExists(program, id, mark) {
  const metadata = functionMetadata(program, id);
  const instructions = metadata ? Object.values(metadata.continuations) : program.functions[id].code;
  return instructions.some((instruction) => instruction.op === "stack_mark" && instruction.id === mark);
}

export function functionCaptureSites(program, id) {
  return functionMetadata(program, id)?.captures ?? program.functions[id].code;
}

export function legacyInstructions(program, id) {
  const metadata = functionMetadata(program, id);
  return metadata ? Object.values(metadata.continuations) : program.functions[id].code;
}

export function packageCodeStats(program) {
  return providers.get(program)?.stats() ?? null;
}
