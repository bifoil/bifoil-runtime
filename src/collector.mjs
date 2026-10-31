// Trace and compact the VM-owned graph only at instruction boundaries.
// JavaScript temporaries must never be the sole owners of live VM values here.
import { check } from "./errors.mjs";
import { CapturePlans } from "./closure-captures.mjs";

const HEAP_KINDS = ["list", "set", "map", "entry", "data", "address"];

function relocationTable(items) {
  const table = new Int32Array(items.length);
  table.fill(-1);
  return table;
}

export function collectGarbage(machine) {
  const state = machine.state;
  const captures = new CapturePlans(machine);
  const live = {
    cells: new Uint8Array(state.cells.length),
    envs: new Uint8Array(state.envs.length),
    objects: new Uint8Array(state.objects.length),
  };
  const pending = [];
  function mark(kind, id) {
    check(Number.isInteger(id) && id >= 0 && id < live[kind].length, "invalid garbage-collection reference");
    if (live[kind][id]) return;
    live[kind][id] = 1;
    pending.push([kind, id]);
  }
  function markValue(value) {
    if (!value) return;
    if (HEAP_KINDS.includes(value.kind)) mark("objects", value.ref);
    if (value.kind === "address") markValue(value.key);
    if (value.kind === "function" || value.kind === "scene") {
      const plan = captures.forValue(value);
      if (plan) Object.values(plan.bindings).forEach((id) => mark("cells", id));
      else mark("envs", value.env);
    }
    if (
      ["function", "scene", "builtin"].includes(value.kind) &&
      value.receiver !== undefined &&
      value.receiver !== null
    ) {
      mark("cells", value.receiver);
    }
  }
  mark("envs", 0);
  for (const frame of state.frames) {
    mark("envs", frame.env);
    frame.stack.forEach(markValue);
    for (const iterator of Object.values(frame.iterators ?? {})) {
      if (iterator.range) markValue(iterator.range);
      else if (iterator.kind !== "string") iterator.items.forEach(markValue);
    }
  }
  while (pending.length) {
    const [kind, id] = pending.pop();
    const node = state[kind][id];
    if (kind === "envs") {
      if (node.parent !== null) mark("envs", node.parent);
      Object.values(node.bindings).forEach((id) => mark("cells", id));
    } else if (kind === "cells") {
      if (node.initialized !== false) markValue(node.value);
    } else if (node.kind === "list" || node.kind === "set") node.items.forEach(markValue);
    else if (node.kind === "map")
      node.entries.forEach(([key, value]) => {
        markValue(key);
        markValue(value);
      });
    else if (node.kind === "entry") {
      markValue(node.key);
      markValue(node.value);
    } else if (node.kind === "data") Object.values(node.fields).forEach((id) => mark("cells", id));
  }

  const relocation = {
    cells: relocationTable(state.cells),
    envs: relocationTable(state.envs),
    objects: relocationTable(state.objects),
  };
  const compacted = { cells: [], envs: [], objects: [] };
  for (const kind of Object.keys(compacted)) {
    state[kind].forEach((item, id) => {
      if (!live[kind][id]) return;
      relocation[kind][id] = compacted[kind].length;
      compacted[kind].push(item);
    });
  }
  const reclaimed = Object.fromEntries(
    Object.keys(compacted).map((kind) => [kind, state[kind].length - compacted[kind].length]),
  );
  captures.appendEnvironments(compacted.envs);
  function moved(kind, id) {
    const updated = relocation[kind][id];
    check(updated >= 0, "garbage collection lost a live reference");
    return updated;
  }
  // A value object may be shared by multiple cells and containers. Rewrite each
  // JavaScript object once; applying the old-to-new map twice corrupts aliases.
  const rewritten = new WeakSet();
  function rewriteValue(value) {
    if (!value || rewritten.has(value)) return;
    rewritten.add(value);
    if (HEAP_KINDS.includes(value.kind)) value.ref = moved("objects", value.ref);
    if (value.kind === "address") rewriteValue(value.key);
    if (value.kind === "function" || value.kind === "scene") {
      const plan = captures.values.get(value);
      value.env = plan ? plan.env : moved("envs", value.env);
    }
    if (
      ["function", "scene", "builtin"].includes(value.kind) &&
      value.receiver !== undefined &&
      value.receiver !== null
    ) {
      value.receiver = moved("cells", value.receiver);
    }
  }
  const rewriteBindings = (bindings) =>
    Object.fromEntries(Object.entries(bindings).map(([name, id]) => [name, moved("cells", id)]));
  for (const env of compacted.envs) {
    if (env.parent !== null) env.parent = moved("envs", env.parent);
    env.bindings = rewriteBindings(env.bindings);
  }
  for (const cell of compacted.cells) if (cell.initialized !== false) rewriteValue(cell.value);
  for (const object of compacted.objects) {
    if (object.kind === "list" || object.kind === "set") object.items.forEach(rewriteValue);
    else if (object.kind === "map")
      object.entries.forEach(([key, value]) => {
        rewriteValue(key);
        rewriteValue(value);
      });
    else if (object.kind === "entry") {
      rewriteValue(object.key);
      rewriteValue(object.value);
    } else if (object.kind === "data") object.fields = rewriteBindings(object.fields);
  }
  for (const frame of state.frames) {
    frame.env = moved("envs", frame.env);
    frame.stack.forEach(rewriteValue);
    for (const iterator of Object.values(frame.iterators ?? {})) {
      if (iterator.range) rewriteValue(iterator.range);
      else if (iterator.kind !== "string") iterator.items.forEach(rewriteValue);
    }
  }
  Object.assign(state, compacted);
  return reclaimed;
}

export function collectIfNeeded(machine) {
  const size = Math.max(machine.state.cells.length, machine.state.envs.length, machine.state.objects.length);
  const threshold = machine.collectionThreshold ?? 8192;
  if (size < threshold || size <= (machine.lastCollectionSize ?? -1)) return;
  collectGarbage(machine);
  const remaining = Math.max(machine.state.cells.length, machine.state.envs.length, machine.state.objects.length);
  machine.lastCollectionSize = remaining;
  machine.collectionThreshold = Math.min(99000, Math.max(8192, Math.ceil(remaining * 1.5)));
}
