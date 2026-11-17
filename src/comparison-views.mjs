// Comparison views describe how an operand is exposed by this expression.
// They never replace a value's retained construction identity or copy its data.
import { collection, present, substitute } from "./types.mjs";

function canonicalType(type) {
  switch (type.kind) {
    case "nullable":
      return [type.kind, canonicalType(type.inner)];
    case "named":
      return [type.kind, type.name, type.args.map(canonicalType)];
    case "parameter":
      return [type.kind, type.name, !!type.nonnull];
    case "function":
      return [type.kind, !!type.suspend, !!type.vararg, type.params.map(canonicalType), canonicalType(type.result)];
    case "scene":
      return [type.kind, type.params.map(canonicalType)];
    default:
      return [type.kind];
  }
}

export class ComparisonViews {
  constructor(machine) {
    this.machine = machine;
    this.identities = new Map();
    this.fields = new Map();
  }
  effective(type, value) {
    const view = present(type ?? this.machine.valueType(value));
    // Unknown positions do not make unlike primitive kinds or retained nominal
    // identities equal. Static capability checking still controls eligibility.
    return ["any", "star"].includes(view.kind) ? this.machine.valueType(value) : view;
  }
  identity(type) {
    const key = JSON.stringify(canonicalType(type));
    let id = this.identities.get(key);
    if (id === undefined) {
      id = this.identities.size;
      this.identities.set(key, id);
    }
    return id;
  }
  child(view, object, position) {
    const container = collection(view);
    if (container) return container.args[position === "value" ? 1 : 0];
    if (view.kind === "named" && view.name === "Entry") return view.args[position === "value" ? 1 : 0];
    if (object.kind !== "data") return undefined;
    const key = object.type.name + ":" + this.identity(view);
    let fields = this.fields.get(key);
    if (!fields) {
      const definition = this.machine.program.types?.[object.type.name];
      // A sealed-parent view exposes the active variant's payload with that
      // parent's arguments. Variants inherit their enclosing sum's parameters.
      const argumentsByName = Object.fromEntries(
        (definition?.parameters ?? []).map((parameter, index) => [parameter.name, view.args[index]]),
      );
      fields = Object.fromEntries(
        Object.entries(definition?.fields ?? {}).map(([name, field]) => [name, substitute(field.ty, argumentsByName)]),
      );
      this.fields.set(key, fields);
    }
    return fields[position];
  }
}
