// A plain-data graph for native engine continuations. Preserve aliases, cycles,
// undefined values and special numbers without putting host objects in VM saves.
import { check } from "../errors.mjs";

export function encodeState(root) {
  const nodes = [],
    identities = new Map(),
    pending = [];
  function reference(value) {
    if (value === null) return ["null"];
    if (value === undefined) return ["undefined"];
    if (typeof value === "number")
      return [
        "number",
        Object.is(value, -0)
          ? "-0"
          : Number.isNaN(value)
            ? "NaN"
            : value === Infinity
              ? "+Infinity"
              : value === -Infinity
                ? "-Infinity"
                : value,
      ];
    if (typeof value === "string" || typeof value === "boolean") return [typeof value, value];
    check(typeof value === "object", "native continuation contains a host function");
    if (identities.has(value)) return ["ref", identities.get(value)];
    const id = nodes.length;
    identities.set(value, id);
    nodes.push({ array: Array.isArray(value), ...(Array.isArray(value) ? { length: value.length } : {}), entries: [] });
    pending.push([value, id]);
    return ["ref", id];
  }
  const value = reference(root);
  while (pending.length) {
    const [object, id] = pending.pop();
    nodes[id].entries = Object.entries(object).map(([key, item]) => [key, reference(item)]);
  }
  return { format: "bifoil.legacy-state.v1", root: value, nodes };
}

export function decodeState(snapshot) {
  check(
    snapshot?.format === "bifoil.legacy-state.v1" && Array.isArray(snapshot.nodes),
    "invalid native continuation graph",
  );
  const objects = snapshot.nodes.map((node) => {
    check(node && typeof node.array === "boolean" && Array.isArray(node.entries), "invalid native graph node");
    if (!node.array) return {};
    check(
      Number.isSafeInteger(node.length) && node.length >= 0 && node.length <= 16000000,
      "invalid native array length",
    );
    return new Array(node.length);
  });
  function value(encoded) {
    check(Array.isArray(encoded), "invalid native graph value");
    switch (encoded[0]) {
      case "null":
        return null;
      case "undefined":
        return undefined;
      case "string":
        check(typeof encoded[1] === "string", "invalid native text");
        return encoded[1];
      case "boolean":
        check(typeof encoded[1] === "boolean", "invalid native Boolean");
        return encoded[1];
      case "number": {
        if (typeof encoded[1] === "number") {
          check(Number.isFinite(encoded[1]), "invalid native number");
          return encoded[1];
        }
        check(["-0", "NaN", "+Infinity", "-Infinity"].includes(encoded[1]), "invalid native special number");
        return { "-0": -0, NaN, "+Infinity": Infinity, "-Infinity": -Infinity }[encoded[1]];
      }
      case "ref":
        check(
          Number.isInteger(encoded[1]) && encoded[1] >= 0 && encoded[1] < objects.length,
          "invalid native reference",
        );
        return objects[encoded[1]];
      default:
        throw new Error("unknown native graph value");
    }
  }
  snapshot.nodes.forEach((node, id) => {
    const keys = new Set();
    for (const entry of node.entries) {
      check(
        Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          !keys.has(entry[0]) &&
          (!node.array || entry[0] !== "length"),
        "invalid native graph entry",
      );
      keys.add(entry[0]);
      Object.defineProperty(objects[id], entry[0], {
        value: value(entry[1]),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  });
  return value(snapshot.root);
}
