import { check } from "./errors.mjs";

export function nullable(type) {
  if (type.kind === "nullable" || type.kind === "null") return type;
  // Adding null erases a parameter's non-null refinement, preserving canonical identity.
  const inner = type.kind === "parameter" && type.nonnull ? { kind: "parameter", name: type.name } : type;
  return { kind: "nullable", inner };
}
export function nonNull(type) {
  if (type.kind === "nullable") return nonNull(type.inner);
  if (type.kind === "null") return { kind: "nothing" };
  if (type.kind === "parameter") return { ...type, nonnull: true };
  if (type.kind === "star") return { kind: "any" };
  return type;
}
export const present = (type) => (type.kind === "nullable" ? type.inner : type);
export const collection = (type) => {
  if (type.kind !== "named") return null;
  const family = type.name.replace(/^Mutable/, "");
  return ["List", "Set", "Map"].includes(family)
    ? { family, args: type.args, mutable: type.name.startsWith("Mutable") }
    : null;
};
// A star hides an existing argument; it never creates a concrete element type.
// Copying fills projected slots from the source, including nested projections.
function nominalParent(type, definitions) {
  const definition = definitions[type.name];
  if (!definition?.parent) return null;
  const args = Object.fromEntries((definition.parameters ?? []).map((parameter, i) => [parameter.name, type.args[i]]));
  return typeof definition.parent === "string"
    ? { kind: "named", name: definition.parent, args: type.args }
    : substitute(definition.parent, args);
}
function nominalView(source, name, definitions) {
  if (source.name === name) return source;
  const visited = new Set();
  let view = source;
  while (view && view.name !== name) {
    check(!visited.has(view.name), "cyclic nominal parent metadata");
    visited.add(view.name);
    view = nominalParent(view, definitions);
  }
  return view;
}
function projectedCopyType(target, source, definitions) {
  if (target.kind === "star") return source;
  if (target.kind === "nullable") return nullable(projectedCopyType(target.inner, present(source), definitions));
  if (target.kind !== source.kind) return target;
  if (target.kind === "named") {
    const view = nominalView(source, target.name, definitions);
    if (!view) return target;
    return {
      ...target,
      args: target.args.map((argument, i) => projectedCopyType(argument, view.args[i], definitions)),
    };
  }
  if (target.kind === "function" || target.kind === "scene") {
    if (source.params.length !== target.params.length) return target;
    return {
      ...target,
      params: target.params.map((parameter, i) => projectedCopyType(parameter, source.params[i], definitions)),
      ...(target.kind === "function" ? { result: projectedCopyType(target.result, source.result, definitions) } : {}),
    };
  }
  return target;
}
export function reifyCollectionCopy(target, source, definitions = {}) {
  const requested = collection(target),
    actual = collection(source);
  check(requested && actual && requested.family === actual.family, "invalid collection copy types");
  return {
    ...target,
    args: requested.args.map((argument, index) => {
      const projected = projectedCopyType(argument, actual.args[index], definitions);
      // A direct star retains an unknown argument. Nested projected types are
      // ordinary argument types in invariant slots: a fresh MutableList<List<*>>
      // must still permit both List<Int> and List<String> elements.
      const covariant = !requested.mutable && (requested.family !== "Map" || index === 1);
      return argument.kind === "star" || (covariant && subtype(projected, argument, definitions))
        ? projected
        : argument;
    }),
  };
}
export function sameType(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  switch (a.kind) {
    case "nullable":
      return sameType(a.inner, b.inner);
    case "named":
      return a.name === b.name && a.args.length === b.args.length && a.args.every((v, i) => sameType(v, b.args[i]));
    case "parameter":
      return a.name === b.name && !!a.nonnull === !!b.nonnull;
    case "scene":
      return a.params.length === b.params.length && a.params.every((v, i) => sameType(v, b.params[i]));
    case "function":
      return (
        !!a.suspend === !!b.suspend &&
        !!a.vararg === !!b.vararg &&
        sameType(a.result, b.result) &&
        a.params.length === b.params.length &&
        a.params.every((v, i) => sameType(v, b.params[i]))
      );
    default:
      return true;
  }
}
export function subtype(source, target, definitions = {}) {
  if (sameType(source, target) || source.kind === "nothing" || target.kind === "star") return true;
  if (source.kind === "parameter" && target.kind === "parameter" && source.name === target.name)
    return !target.nonnull || !!source.nonnull;
  if (target.kind === "any")
    return (
      (source.kind === "parameter" && !!source.nonnull) ||
      !["nullable", "null", "parameter", "star"].includes(source.kind)
    );
  if (target.kind === "nullable")
    return target.inner.kind === "any" || source.kind === "null" || subtype(present(source), target.inner, definitions);
  if (source.kind === "nullable" || source.kind === "null") return false;
  if (source.kind === "function" && target.kind === "function") {
    return (
      (!source.suspend || target.suspend) &&
      !!source.vararg === !!target.vararg &&
      source.params.length === target.params.length &&
      source.params.every((type, i) => subtype(target.params[i], type, definitions)) &&
      subtype(source.result, target.result, definitions)
    );
  }
  if (source.kind === "named" && target.kind === "named") {
    if (source.name === "IntRange" && target.name === "IntProgression") return true;
    const view = nominalView(source, target.name, definitions);
    if (!view || view.args.length !== target.args.length) return false;
    source = view;
    const definition = definitions[source.name];
    const builtin = collection(source);
    return source.args.every((arg, i) => {
      if (target.args[i].kind === "star") return true;
      const variance =
        source.name === "Entry" || (builtin && !builtin.mutable && (builtin.family !== "Map" || i === 1))
          ? 1
          : (definition?.parameters?.[i]?.variance ?? 0);
      return variance > 0
        ? subtype(arg, target.args[i], definitions)
        : variance < 0
          ? subtype(target.args[i], arg, definitions)
          : sameType(arg, target.args[i]);
    });
  }
  return false;
}
export function typeValid(type, depth = 0) {
  if (!type || depth > 64 || typeof type.kind !== "string") return false;
  if (["int", "float", "boolean", "string", "char", "unit", "null", "nothing", "any", "star"].includes(type.kind))
    return true;
  if (type.kind === "nullable") return type.inner?.kind !== "nullable" && typeValid(type.inner, depth + 1);
  if (type.kind === "parameter")
    return typeof type.name === "string" && (type.nonnull === undefined || typeof type.nonnull === "boolean");
  if (type.kind === "named")
    return typeof type.name === "string" && Array.isArray(type.args) && type.args.every((a) => typeValid(a, depth + 1));
  if (type.kind === "scene") return Array.isArray(type.params) && type.params.every((a) => typeValid(a, depth + 1));
  return (
    type.kind === "function" &&
    typeof type.suspend === "boolean" &&
    (type.vararg === undefined || typeof type.vararg === "boolean") &&
    Array.isArray(type.params) &&
    (!type.vararg || type.params.length > 0) &&
    type.params.every((p) => typeValid(p, depth + 1)) &&
    typeValid(type.result, depth + 1)
  );
}
export function signatureType(sig) {
  if (sig.scene) return { kind: "scene", params: sig.params.map((p) => p.ty) };
  return {
    kind: "function",
    params: sig.params.map((p) => p.ty),
    result: sig.result,
    suspend: sig.suspend,
    ...(sig.params.at(-1)?.vararg ? { vararg: true } : {}),
  };
}
export function substitute(type, args) {
  if (type.kind === "parameter") {
    check(Object.hasOwn(args, type.name), "unresolved runtime type parameter " + type.name);
    return type.nonnull ? nonNull(args[type.name]) : args[type.name];
  }
  if (type.kind === "nullable") return nullable(substitute(type.inner, args));
  if (type.kind === "named") return { ...type, args: type.args.map((a) => substitute(a, args)) };
  if (type.kind === "function")
    return { ...type, params: type.params.map((a) => substitute(a, args)), result: substitute(type.result, args) };
  if (type.kind === "scene") return { ...type, params: type.params.map((a) => substitute(a, args)) };
  return type;
}
