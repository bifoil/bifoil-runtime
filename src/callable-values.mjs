// Function values retain a compiled target plus an optional safe static view.
// Reification closes generic arguments; variance may widen the exposed view,
// but a saved descriptor cannot replace the target's calling contract.
import { substitute, subtype, typeValid } from "./types.mjs";
import { BifoilError, check } from "./errors.mjs";

export function validTypeArguments(arguments_) {
  return (
    arguments_ === undefined ||
    (arguments_ !== null &&
      typeof arguments_ === "object" &&
      !Array.isArray(arguments_) &&
      Object.values(arguments_).every((type) => typeValid(type)))
  );
}

export function functionValueType(machine, value) {
  const signature = machine.program.functions[value.id]?.signature;
  check(signature, "unknown function target");
  // Keep an unspecialized declaration's own template parameters, while closing
  // outer arguments and any explicitly selected specialization.
  const parameters = Object.fromEntries(
    (signature.generics ?? []).map(({ name }) => [name, { kind: "parameter", name }]),
  );
  return substitute(machine.functionType(signature), { ...parameters, ...value.typeArgs });
}

export function validFunctionValue(machine, value) {
  if (typeof value.id !== "string" || !Object.hasOwn(machine.program.functions, value.id)) return false;
  const signature = machine.program.functions[value.id].signature;
  if ((value.kind === "scene") !== !!signature.scene && machine.program.profile !== "bifoil-vm.v1") return false;
  if (!Number.isInteger(value.env) || value.env < 0 || value.env >= machine.state.envs.length) return false;
  if (
    value.receiver !== undefined &&
    (!Number.isInteger(value.receiver) || value.receiver < 0 || value.receiver >= machine.state.cells.length)
  )
    return false;
  if (!validTypeArguments(value.typeArgs)) return false;
  if (value.type === undefined) return true;
  if (!typeValid(value.type)) return false;
  try {
    const actual = functionValueType(machine, value);
    return value.type.kind === actual.kind && subtype(actual, value.type, machine.program.types ?? {});
  } catch (error) {
    if (error instanceof BifoilError) return false;
    throw error;
  }
}
