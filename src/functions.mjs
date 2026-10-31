// Global function bindings are immutable declarations, separate from mutable heap cells.
export function rootFunction(program, name) {
  if (!Object.hasOwn(program.functions, name)) return null;
  const fn = program.functions[name];
  if (fn.init || (fn.local === undefined ? name.includes("$") : fn.local)) return null;
  return fn;
}
