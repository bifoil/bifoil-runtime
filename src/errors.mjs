export class BifoilError extends Error {
  constructor(message, span) {
    super((span ? span.file + ":" + span.line + ": " : "") + message);
    this.name = "BifoilError";
    this.span = span;
  }
}
export function check(condition, message) {
  if (!condition) throw new BifoilError(message);
}

export function ensureLive(machine) {
  if (machine.failure) throw machine.failure;
}
export function haltExecution(machine, failure) {
  if (machine.failure) return machine.failure;
  const error =
    failure instanceof BifoilError && failure.span ? failure : new BifoilError(failure.message, machine.span);
  machine.failure = error;
  machine.state.failed = true;
  machine.state.pending = null;
  // Release host-owned continuations; cleanup cannot mask the original failure.
  try {
    machine.legacy?.cancel?.();
  } catch {
    /* Preserve the checked diagnostic. */
  }
  return error;
}
