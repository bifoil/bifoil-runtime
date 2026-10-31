import { findKey, invalidateKeys } from "./collection-index.mjs";
import { stringify } from "./rendering.mjs";
import { scalarLength, scalarAt, scalarSubstring } from "./text.mjs";
// Container, object, prose, and control-transfer instructions used by the VM.
import { BifoilError, check } from "./errors.mjs";
import { collection, sameType, signatureType, reifyCollectionCopy } from "./types.mjs";
import { value, int, nullValue as nil, unit } from "./values.mjs";
import { RuntimeFrames } from "./frames.mjs";

function checkedIndex(index, size, allowEnd = false) {
  check(
    index.kind === "int" && index.value >= 0 && (allowEnd ? index.value <= size : index.value < size),
    "index out of bounds",
  );
  return index.value;
}

export class RuntimeMembers extends RuntimeFrames {
  captureReceiver(receiver) {
    check(this.state.cells.length < 100000, "runtime heap budget exceeded");
    return (
      this.state.cells.push({ ty: this.valueType(receiver), mutable: false, initialized: true, value: receiver }) - 1
    );
  }
  getMember(receiver, name, type, functionId = null) {
    check(receiver.kind !== "null", "null member access");
    if (receiver.kind === "string" && name === "length") return int(scalarLength(receiver.value));
    if (receiver.kind === "char" && name === "code") return int(receiver.value.codePointAt(0));
    if (["list", "set", "map"].includes(receiver.kind) && name === "size") {
      const object = this.object(receiver);
      return int(receiver.kind === "map" ? object.entries.length : object.items.length);
    }
    if (receiver.kind === "range" && ["first", "last", "step"].includes(name)) return int(receiver[name]);
    if (receiver.kind === "entry" && ["key", "value"].includes(name)) return this.object(receiver)[name];
    if (functionId?.startsWith("$builtin.")) {
      check(type.kind === "function" && functionId === "$builtin." + name, "invalid builtin member target");
      return { kind: "builtin", name, receiver: this.captureReceiver(receiver), type };
    }
    if (receiver.kind === "data") {
      const object = this.object(receiver),
        definition = this.program.types?.[object.type.name];
      if (Object.hasOwn(object.fields, name)) return this.state.cells[object.fields[name]].value;
      const declared = definition?.methods?.[name];
      const candidates = Array.isArray(declared) ? declared : declared ? [declared] : [];
      const method = functionId
        ? candidates.find((candidate) => candidate.id === functionId)
        : candidates.length === 1
          ? candidates[0]
          : null;
      check(method, "unknown or ambiguous data member " + name);
      // Copies construct explicitly requested arguments, including nested
      // projections. A direct star hides the owner's existing argument instead
      // of requesting a new one, so preserve that concrete reified identity.
      const arguments_ =
        name === "copy" && type.result?.kind === "named" && type.result.name === object.type.name
          ? type.result.args.map((argument, index) => (argument.kind === "star" ? object.type.args[index] : argument))
          : object.type.args;
      const typeArgs = Object.fromEntries((definition.parameters ?? []).map((p, i) => [p.name, arguments_[i]]));
      return { kind: "function", id: method.id, env: 0, receiver: this.captureReceiver(receiver), type, typeArgs };
    }
    check(type.kind === "function", "unknown member " + name);
    return { kind: "builtin", name, receiver: this.captureReceiver(receiver), type };
  }
  getIndex(receiver, key) {
    if (receiver.kind === "string") {
      check(key.kind === "int", "index out of bounds");
      return value("char", scalarAt(receiver.value, key.value));
    }
    const object = this.object(receiver);
    if (receiver.kind === "list") return object.items[checkedIndex(key, object.items.length)];
    check(receiver.kind === "map", "value cannot be indexed");
    const index = findKey(this, object, key);
    return index < 0 ? nil() : object.entries[index][1];
  }
  readAddress(address) {
    check(address.kind === "address", "invalid assignment address");
    const object = this.state.objects[address.ref];
    if (object.kind === "data") {
      check(Object.hasOwn(object.fields, address.key.value), "unknown field");
      return this.state.cells[object.fields[address.key.value]].value;
    }
    return this.getIndex({ kind: object.kind, ref: address.ref, type: object.type }, address.key);
  }
  writeAddress(address, newValue) {
    check(address.kind === "address", "invalid assignment address");
    const object = this.state.objects[address.ref],
      type = collection(object.type);
    if (object.kind === "data") {
      const cell = this.state.cells[object.fields[address.key.value]];
      check(cell?.mutable && this.acceptsType(cell.ty, this.valueType(newValue)), "invalid field update");
      cell.value = newValue;
      return;
    }
    check(type?.mutable, "cannot mutate an immutable collection");
    const expected = type.args[type.family === "Map" ? 1 : 0];
    check(this.acceptsType(expected, this.valueType(newValue)), "collection update type mismatch");
    if (object.kind === "list") object.items[checkedIndex(address.key, object.items.length)] = newValue;
    else {
      check(object.kind === "map", "invalid indexed assignment");
      const found = findKey(this, object, address.key);
      if (found < 0) object.entries.push([address.key, newValue]);
      else object.entries[found][1] = newValue;
    }
  }
  stringify(item) {
    return stringify(this, item);
  }
  invokeBuiltin(callable, args, names, direct) {
    const receiver = callable.receiver === null ? null : this.state.cells[callable.receiver].value;
    const c = receiver ? collection(this.valueType(receiver)) : null;
    const parameterNames =
      {
        Int: ["value"],
        Float: ["value"],
        String: ["value"],
        Char: ["value"],
        substring: ["start", "endExclusive"],
        add: ["element"],
        remove: [c?.family === "Map" ? "key" : "element"],
        contains: ["element"],
        containsKey: ["element"],
        insert: ["index", "element"],
        removeAt: ["index"],
        put: ["key", "value"],
      }[callable.name] ?? [];
    const bound = new Array(callable.type.params.length);
    args.forEach((argument, i) => {
      const index = names[i] === null ? i : parameterNames.indexOf(names[i]);
      check(names[i] === null || direct, "function values require positional arguments");
      check(index >= 0 && index < bound.length && bound[index] === undefined, "invalid builtin argument");
      check(this.acceptsType(callable.type.params[index], this.valueType(argument)), "builtin argument type mismatch");
      bound[index] = argument;
    });
    check(bound.every((v) => v !== undefined) && args.length === bound.length, "missing builtin argument");
    const [a, b] = bound;
    if (receiver === null) {
      switch (callable.name) {
        case "Int":
          check(["int", "float"].includes(a.kind), "Int conversion requires a number");
          return int(Math.trunc(a.value));
        case "Float":
          check(
            ["int", "float"].includes(a.kind) && Number.isFinite(a.value),
            "Float conversion requires a finite number",
          );
          return value("float", a.value);
        case "String":
          return value("string", this.stringify(a));
        case "Char":
          check(
            a.kind === "int" && a.value >= 0 && a.value <= 0x10ffff && (a.value < 0xd800 || a.value > 0xdfff),
            "invalid Unicode scalar",
          );
          return value("char", String.fromCodePoint(a.value));
        default:
          throw new BifoilError("unknown intrinsic");
      }
    }
    switch (callable.name) {
      case "toString":
        return value("string", this.stringify(receiver));
      case "toInt":
        check(["int", "float"].includes(receiver.kind), "numeric conversion required");
        return int(Math.trunc(receiver.value));
      case "toFloat":
        return value("float", receiver.value);
      case "substring": {
        check(a.kind === "int" && b.kind === "int", "invalid substring bounds");
        return value("string", scalarSubstring(receiver.value, a.value, b.value));
      }
      case "isEmpty":
        return value(
          "boolean",
          receiver.kind === "string"
            ? receiver.value.length === 0
            : this.object(receiver)[receiver.kind === "map" ? "entries" : "items"].length === 0,
        );
      case "contains":
      case "containsKey":
        return value("boolean", this.contains(receiver, a));
    }
    if (callable.name.startsWith("to") && c) {
      const target = reifyCollectionCopy(callable.type.result, this.valueType(receiver), this.program.types ?? {}),
        object = this.object(receiver),
        t = collection(target);
      check(t?.family === c.family, "invalid collection copy");
      if (c.family === "Map")
        return this.collectionValue(
          target,
          object.entries.map(([k, v]) => [this.convert(k, t.args[0]), this.convert(v, t.args[1])]),
        );
      return this.collectionValue(
        target,
        object.items.map((item) => this.convert(item, t.args[0])),
      );
    }
    check(c?.mutable, "collection method requires a mutable container");
    const object = this.object(receiver);
    switch (callable.name) {
      case "clear":
        invalidateKeys(object);
        object[c.family === "Map" ? "entries" : "items"] = [];
        return unit();
      case "add":
        if (c.family === "Set" && findKey(this, object, a) >= 0) return value("boolean", false);
        object.items.push(a);
        return value("boolean", true);
      case "insert":
        object.items.splice(checkedIndex(a, object.items.length, true), 0, b);
        return unit();
      case "removeAt":
        return object.items.splice(checkedIndex(a, object.items.length), 1)[0];
      case "remove": {
        if (c.family === "Map") {
          const index = findKey(this, object, a);
          if (index < 0) return nil();
          invalidateKeys(object);
          return object.entries.splice(index, 1)[0][1];
        }
        const index = c.family === "Set" ? findKey(this, object, a) : object.items.findIndex((v) => this.equal(v, a));
        if (index < 0) return value("boolean", false);
        invalidateKeys(object);
        object.items.splice(index, 1);
        return value("boolean", true);
      }
      case "put": {
        const index = findKey(this, object, a);
        if (index < 0) {
          object.entries.push([a, b]);
          return nil();
        }
        const previous = object.entries[index][1];
        object.entries[index][1] = b;
        return previous;
      }
      default:
        throw new BifoilError("unknown builtin method " + callable.name);
    }
  }
}
