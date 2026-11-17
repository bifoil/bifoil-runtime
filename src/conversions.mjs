// Convert collection contents with owned continuation frames. Container depth
// must not consume the host call stack. Implicit map conversions check each key
// before its value. Explicit copies can reuse the source key inventory only
// when its key type is unchanged.
import { check } from "./errors.mjs";
import { findKey } from "./collection-index.mjs";
import { collection, reifyCollectionCopy, sameType } from "./types.mjs";
import { value as primitive } from "./values.mjs";

export function copyCollection(machine, value, type) {
  const source = collection(machine.valueType(value));
  check(source && collection(type)?.family === source.family, "invalid collection copy");
  return convertValue(machine, value, type, { copyRoot: true });
}

export function convertValue(machine, value, type, { copyRoot = false } = {}) {
  const pending = [{ kind: "convert", value, type, copy: copyRoot }];
  let result;
  while (pending.length) {
    const task = pending.pop();
    if (task.kind === "convert") {
      const input = task.value;
      const requested = machine.resolveType(task.type);
      if (!task.copy && machine.acceptsType(requested, machine.valueType(input))) {
        result = input;
        continue;
      }
      if (requested.kind === "nullable") {
        if (input.kind === "null") result = input;
        else pending.push({ ...task, type: requested.inner });
        continue;
      }
      if (requested.kind === "float" && input.kind === "int") {
        result = primitive("float", input.value);
        continue;
      }
      if (requested.kind === "string" && input.kind === "char") {
        result = primitive("string", input.value);
        continue;
      }
      const source = collection(machine.valueType(input));
      check(collection(requested) && source?.family === collection(requested).family, "unsupported value conversion");
      const outputType = reifyCollectionCopy(requested, machine.valueType(input), machine.program.types ?? {});
      const target = collection(outputType);
      check(task.copy || target.mutable !== source.mutable || !target.mutable, "mutable type arguments are invariant");
      pending.push({
        kind: target.family === "Map" ? "map" : "items",
        source: machine.object(input),
        copy: !!task.copy,
        checkKeys: !task.copy || (target.family === "Map" && !sameType(source.args[0], target.args[0])),
        target,
        type: outputType,
        builder:
          target.family === "Map" ? { kind: "map", entries: [] } : { kind: target.family.toLowerCase(), items: [] },
        index: 0,
        phase: "next",
      });
      continue;
    }
    if (task.kind === "items") {
      if (task.phase === "store") {
        task.builder.items.push(result);
        task.index++;
      }
      if (task.index === task.source.items.length) {
        // Finish all element conversions before coalescing a set, matching the
        // ordinary construction order while preserving first-insertion order.
        let items = task.builder.items;
        if (task.target.family === "Set" && !task.copy) {
          const unique = { kind: "set", items: [] };
          for (const item of items) if (findKey(machine, unique, item) < 0) unique.items.push(item);
          items = unique.items;
        }
        result = machine.collectionValue(task.type, items);
      } else {
        task.phase = "store";
        pending.push(task, { kind: "convert", value: task.source.items[task.index], type: task.target.args[0] });
      }
      continue;
    }
    if (task.phase === "next") {
      if (task.index === task.source.entries.length) {
        result = machine.collectionValue(task.type, task.builder.entries);
      } else {
        task.phase = "check";
        pending.push(task, { kind: "convert", value: task.source.entries[task.index][0], type: task.target.args[0] });
      }
    } else if (task.phase === "check") {
      if (task.checkKeys) check(findKey(machine, task.builder, result) < 0, "conversion produced a duplicate map key");
      task.key = result;
      task.phase = "store";
      pending.push(task, { kind: "convert", value: task.source.entries[task.index][1], type: task.target.args[1] });
    } else {
      task.builder.entries.push([task.key, result]);
      task.index++;
      task.phase = "next";
      pending.push(task);
    }
  }
  return result;
}
