// Restored objects must retain the same typed representation as live objects.
// Inspect references rather than recursively walking values, so cycles are valid.
import { check } from "./errors.mjs";
import { collection, sameType, substitute, typeValid } from "./types.mjs";

export function validateHeapObject(machine, object) {
  check(
    object && typeValid(object.type) && ["list", "set", "map", "entry", "data"].includes(object.kind),
    "invalid checkpoint object",
  );
  const accepts = (type, item) => machine.validValue(item) && machine.acceptsType(type, machine.valueType(item));
  if (["list", "set", "map"].includes(object.kind)) {
    const type = collection(object.type);
    check(
      type && type.family.toLowerCase() === object.kind && type.args.length === (object.kind === "map" ? 2 : 1),
      "invalid checkpoint collection type",
    );
    if (object.kind === "map") {
      check(
        Array.isArray(object.entries) &&
          object.entries.every(
            (entry) =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              entry.every((item, index) => accepts(type.args[index], item)),
          ),
        "invalid map entry",
      );
    } else {
      check(
        Array.isArray(object.items) && object.items.every((item) => accepts(type.args[0], item)),
        "invalid collection element",
      );
    }
    return;
  }
  if (object.kind === "entry") {
    const type = object.type;
    check(
      type.kind === "named" &&
        type.name === "Entry" &&
        type.args.length === 2 &&
        accepts(type.args[0], object.key) &&
        accepts(type.args[1], object.value),
      "invalid checkpoint entry",
    );
    return;
  }
  validateNominal(machine, object);
}

function validateNominal(machine, object) {
  const type = object.type;
  const definition = type.kind === "named" && machine.program.types?.[type.name];
  check(
    definition &&
      ["data", "variant", "enum"].includes(definition.kind) &&
      type.args.length === (definition.parameters ?? []).length,
    "invalid checkpoint nominal type",
  );
  const validTag =
    definition.kind === "enum"
      ? definition.variants?.includes(type.name + "." + object.tag)
      : definition.kind === "variant"
        ? object.tag === type.name.slice(type.name.lastIndexOf(".") + 1)
        : object.tag === undefined || object.tag === null;
  check(validTag, "invalid checkpoint nominal tag");
  check(
    object.fields &&
      typeof object.fields === "object" &&
      !Array.isArray(object.fields) &&
      Object.keys(object.fields).length === Object.keys(definition.fields).length,
    "invalid checkpoint nominal fields",
  );
  const argumentsByName = Object.fromEntries(
    (definition.parameters ?? []).map((parameter, index) => [parameter.name, type.args[index]]),
  );
  for (const [name, field] of Object.entries(definition.fields)) {
    const id = object.fields[name];
    const cell = Number.isInteger(id) && id >= 0 && machine.state.cells[id];
    check(
      Object.hasOwn(object.fields, name) &&
        cell &&
        cell.initialized !== false &&
        cell.legacy === undefined &&
        cell.mutable === field.mutable &&
        sameType(cell.ty, substitute(field.ty, argumentsByName)),
      "invalid checkpoint field " + name,
    );
  }
}
