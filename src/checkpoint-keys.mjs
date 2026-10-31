// Stored keys must retain immutable, equality-supporting value graphs.
// Walk references iteratively: shared aliases and immutable cycles remain valid.
import { check } from "./errors.mjs";
import { collection } from "./types.mjs";
import { findKey } from "./collection-index.mjs";

const REFERENCES = new Set(["list", "set", "map", "entry", "data"]);
const PRIMITIVES = new Set(["int", "float", "boolean", "string", "char", "null", "unit", "range", "scene"]);
const KEY_ERROR = "checkpoint key does not have stable equality";

function* storedKeys(object) {
  if (object.kind === "set") yield* object.items;
  else if (object.kind === "map") {
    for (const [key] of object.entries) yield key;
  }
}

function validateKey(machine, root, visited) {
  const pending = [root];
  while (pending.length) {
    const item = pending.pop();
    if (!REFERENCES.has(item.kind)) {
      check(PRIMITIVES.has(item.kind), KEY_ERROR);
      continue;
    }
    if (visited.has(item.ref)) continue;
    visited.add(item.ref);
    const object = machine.state.objects[item.ref];
    check(!collection(object.type)?.mutable, KEY_ERROR);
    if (object.kind === "data") {
      for (const id of Object.values(object.fields)) {
        const cell = machine.state.cells[id];
        check(!cell.mutable, KEY_ERROR);
        pending.push(cell.value);
      }
    } else if (object.kind === "map") {
      for (const [key, value] of object.entries) pending.push(key, value);
    } else if (object.kind === "entry") pending.push(object.key, object.value);
    else {
      // Push one at a time: a large saved container must not become JS call arguments.
      for (const value of object.items) pending.push(value);
    }
  }
}

export function validateStoredKeys(machine) {
  const visited = new Set();
  // Heap shapes, values, and field references are already validated by the caller.
  for (const object of machine.state.objects) {
    for (const key of storedKeys(object)) validateKey(machine, key, visited);
  }
  for (const object of machine.state.objects) {
    if (object.kind !== "set" && object.kind !== "map") continue;
    const seen = { kind: "set", items: [] };
    for (const key of storedKeys(object)) {
      check(
        findKey(machine, seen, key) < 0,
        object.kind === "set" ? "duplicate checkpoint set element" : "duplicate checkpoint map key",
      );
      seen.items.push(key);
    }
  }
}
