import { isSingleScalar } from "../text.mjs";
// Checked native representations shared by state and subroutine bridges.
import { check } from "../errors.mjs";
import { value, int, float, nullValue, unit, isScalarString } from "../values.mjs";

const enumCases = new WeakMap();
function enumTags(type, definitions) {
  if (type?.kind !== "named" || !Array.isArray(type.args ?? []) || (type.args ?? []).length !== 0) return null;
  const definition = definitions && Object.hasOwn(definitions, type.name) ? definitions[type.name] : null;
  if (
    definition?.kind !== "enum" ||
    !Array.isArray(definition.parameters ?? []) ||
    (definition.parameters ?? []).length !== 0 ||
    definition.parent != null ||
    !definition.fields ||
    Array.isArray(definition.fields) ||
    typeof definition.fields !== "object" ||
    Object.keys(definition.fields).length !== 0
  )
    return null;
  const cached = enumCases.get(definition);
  if (cached) return cached.name === type.name ? cached.tags : null;
  const prefix = type.name + ".";
  if (
    !Array.isArray(definition.variants) ||
    !definition.variants.every(
      (name) =>
        typeof name === "string" &&
        name.startsWith(prefix) &&
        name.length > prefix.length &&
        isScalarString(name.slice(prefix.length)),
    )
  )
    return null;
  const tags = new Set(definition.variants.map((name) => name.slice(prefix.length)));
  if (tags.size !== definition.variants.length) return null;
  enumCases.set(definition, { name: type.name, tags });
  return tags;
}

export function boundaryType(type, allowUnit = false, definitions = {}) {
  if (type?.kind === "nullable") return boundaryType(type.inner, false, definitions);
  return (
    ["int", "float", "boolean", "string", "char"].includes(type?.kind) ||
    (allowUnit && type?.kind === "unit") ||
    enumTags(type, definitions) !== null
  );
}
export function fromLegacy(raw, type, machine = null) {
  if (type.kind === "nullable") return raw === null ? nullValue() : fromLegacy(raw, type.inner, machine);
  if (type.kind === "unit") return unit();
  if (type.kind === "int") {
    check(typeof raw === "number", "legacy value is not an Int");
    return int(raw);
  }
  if (type.kind === "float") {
    check(typeof raw === "number", "legacy value is not a Float");
    return float(raw);
  }
  if (type.kind === "boolean") {
    check(typeof raw === "boolean", "legacy value is not Boolean");
    return value("boolean", raw);
  }
  if (type.kind === "string" || type.kind === "char") {
    check(isScalarString(raw), "legacy text is not a Unicode scalar String");
    check(type.kind !== "char" || isSingleScalar(raw), "legacy value is not one Char");
    return value(type.kind, raw);
  }
  const tags = enumTags(type, machine?.program?.types);
  if (tags) {
    check(isScalarString(raw) && tags.has(raw), "legacy value is not an enum case of " + type.name);
    return machine.allocateObject({
      kind: "data",
      type: { kind: "named", name: type.name, args: [] },
      fields: {},
      tag: raw,
    });
  }
  throw new Error("unsupported legacy boundary type");
}
export function toLegacy(item, type, machine = null) {
  if (type.kind === "nullable") return item.kind === "null" ? null : toLegacy(item, type.inner, machine);
  const tags = enumTags(type, machine?.program?.types);
  if (tags) {
    check(item.kind === "data", "legacy enum argument type mismatch");
    const object = machine.object(item);
    check(
      object.kind === "data" &&
        object.type?.kind === "named" &&
        object.type.name === type.name &&
        Array.isArray(object.type.args ?? []) &&
        (object.type.args ?? []).length === 0 &&
        object.fields &&
        !Array.isArray(object.fields) &&
        Object.keys(object.fields).length === 0 &&
        isScalarString(object.tag) &&
        tags.has(object.tag),
      "legacy enum argument type mismatch",
    );
    return object.tag;
  }
  check(item.kind === type.kind, "legacy argument type mismatch");
  // Validate again at the external boundary rather than trusting an arbitrary host.
  fromLegacy(item.value, type, machine);
  return item.value;
}
