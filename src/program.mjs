import { validateInstruction } from "./program-instructions.mjs";
import { functionMetadata, functionLength } from "./program-code.mjs";
import { rootFunction } from "./functions.mjs";
import { validateLegacyProgram } from "./legacy.mjs";
// Validate the compiled instruction envelope before creating execution state.
import { check } from "./errors.mjs";
import { typeValid, sameType } from "./types.mjs";
import { MAX_FUNCTIONS, MAX_INSTRUCTIONS } from "./program-limits.mjs";

import { validateProgramVersion } from "./compatibility.mjs";
export { PROFILE } from "./compatibility.mjs";
const OWN = (object, key) => Object.hasOwn(object, key);
export function validateProgram(program) {
  validateProgramVersion(program);
  check(typeof program.build === "string" && /^[0-9a-f]{64}$/.test(program.build), "invalid build identity");
  check(program.functions && typeof program.functions === "object", "missing functions");
  const functionIds = Object.keys(program.functions);
  check(functionIds.length > 0 && functionIds.length <= MAX_FUNCTIONS, "function budget exceeded");
  let count = 0;
  for (const id of functionIds) {
    const fn = program.functions[id];
    const sig = fn.signature;
    check(
      (fn.init === undefined || typeof fn.init === "boolean") &&
        (fn.local === undefined || typeof fn.local === "boolean"),
      "invalid function flags",
    );
    check(
      sig &&
        sig.id === id &&
        Array.isArray(sig.params) &&
        typeValid(sig.result) &&
        typeof sig.suspend === "boolean" &&
        typeof sig.scene === "boolean",
      "invalid function signature",
    );
    check(
      sig.params.every(
        (p, index) =>
          p &&
          typeof p.name === "string" &&
          p.name.length > 0 &&
          typeValid(p.ty) &&
          typeof p.mutable === "boolean" &&
          typeof p.default === "boolean" &&
          (p.vararg === undefined || typeof p.vararg === "boolean") &&
          (!p.vararg || (index + 1 === sig.params.length && !p.default)),
      ),
      "invalid parameters",
    );
    check(new Set(sig.params.map((p) => p.name)).size === sig.params.length, "duplicate parameters");
    const metadata = functionMetadata(program, id);
    if (!metadata) validateFunctionBody(program, fn);
    count += functionLength(program, id);
    check(count <= MAX_INSTRUCTIONS, "instruction budget exceeded");
  }
  check(
    program.shared === undefined ||
      (program.shared && typeof program.shared === "object" && !Array.isArray(program.shared)),
    "invalid shared definitions",
  );
  for (const [name, definition] of Object.entries(program.shared ?? {})) {
    check(!rootFunction(program, name), "shared state conflicts with a function binding");
    const initializer = program.functions[definition?.initializer]?.signature;
    check(
      typeof name === "string" &&
        typeValid(definition?.ty) &&
        typeof definition.mutable === "boolean" &&
        Number.isInteger(definition.order) &&
        definition.order >= 0 &&
        Array.isArray(definition.dependencies) &&
        definition.dependencies.every((id) => typeof id === "string" && OWN(program.shared, id)) &&
        initializer &&
        initializer.params.length === 0 &&
        !initializer.suspend &&
        !initializer.scene &&
        sameType(initializer.result, definition.ty),
      "invalid shared initializer",
    );
  }
  if (Object.keys(program.shared ?? {}).length || program.shared_order !== undefined) {
    check(Array.isArray(program.shared_order), "missing shared initialization order");
    const initialized = new Set();
    for (const id of program.shared_order) {
      const definition = program.shared?.[id];
      check(definition && !initialized.has(id), "invalid shared initialization order");
      check(
        definition.dependencies.every((dependency) => initialized.has(dependency)),
        "unordered shared dependency",
      );
      initialized.add(id);
    }
    check(initialized.size === Object.keys(program.shared ?? {}).length, "incomplete shared initialization order");
  }
  check(
    OWN(program.functions, program.entry) && program.functions[program.entry].signature.scene,
    "invalid scene entry",
  );
  check(
    Array.isArray(program.init) && program.init.every((id) => OWN(program.functions, id) && program.functions[id].init),
    "invalid initialization order",
  );
  validateLegacyProgram(program);
  return program;
}

export function validateFunctionBody(program, fn) {
  check(Array.isArray(fn.code) && fn.code.length > 0, "invalid function body");
  for (const op of fn.code) validateInstruction(program, op, fn.code.length);
}
