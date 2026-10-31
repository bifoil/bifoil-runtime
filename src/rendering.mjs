// Render explicit String conversions with an owned work stack. Graph depth must
// not consume the JavaScript call stack, and only active ancestors are cycles.
export function stringify(machine, root) {
  const pieces = [];
  const ancestors = new Set();
  const pending = [root];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") {
      pieces.push(item);
      continue;
    }
    if (Object.hasOwn(item, "leave")) {
      ancestors.delete(item.leave);
      continue;
    }
    if (["int", "float", "boolean", "string", "char"].includes(item.kind)) {
      pieces.push(String(item.value));
      continue;
    }
    if (item.kind === "null" || item.kind === "unit") {
      pieces.push(item.kind === "null" ? "null" : "Unit");
      continue;
    }
    if (item.kind === "function" || item.kind === "builtin" || item.kind === "scene") {
      pieces.push(item.kind === "scene" ? item.id : "<function>");
      continue;
    }
    if (item.kind === "range") {
      pieces.push(
        item.first +
          (item.step < 0 ? " downTo " : "..") +
          item.last +
          (Math.abs(item.step) === 1 ? "" : " step " + Math.abs(item.step)),
      );
      continue;
    }
    if (ancestors.has(item.ref)) {
      pieces.push("<cycle>");
      continue;
    }
    const object = machine.object(item);
    ancestors.add(item.ref);
    pending.push({ leave: item.ref });
    if (item.kind === "list" || item.kind === "set") {
      pieces.push(item.kind === "list" ? "[" : "{");
      pending.push(item.kind === "list" ? "]" : "}");
      for (let index = object.items.length - 1; index >= 0; index--) {
        if (index < object.items.length - 1) pending.push(", ");
        pending.push(object.items[index]);
      }
    } else if (item.kind === "map") {
      pieces.push("{");
      pending.push("}");
      for (let index = object.entries.length - 1; index >= 0; index--) {
        if (index < object.entries.length - 1) pending.push(", ");
        const [key, value] = object.entries[index];
        pending.push(value, ": ", key);
      }
    } else if (item.kind === "entry") {
      pending.push(object.value, ": ", object.key);
    } else {
      pieces.push(object.type.name + "(");
      pending.push(")");
      const fields = Object.entries(object.fields);
      for (let index = fields.length - 1; index >= 0; index--) {
        if (index < fields.length - 1) pending.push(", ");
        const [name, cell] = fields[index];
        pending.push(machine.state.cells[cell].value, name + "=");
      }
    }
  }
  return pieces.join("");
}
