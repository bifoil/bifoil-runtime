import { findKey } from "./collection-index.mjs";
import { rootFunction } from "./functions.mjs";
import { functionValueType, validFunctionValue } from "./callable-values.mjs";
import { structuralEqual } from "./equality.mjs";
import { isSingleScalar } from "./text.mjs";
// Heap values, lexical environments, captured cells, and call-frame argument binding.
import { BifoilError, check } from "./errors.mjs";
import {
  collection,
  sameType,
  subtype,
  signatureType,
  typeValid,
  present,
  substitute,
  reifyCollectionCopy,
} from "./types.mjs";
import { value as primitive, nullValue, isScalarString as scalarString } from "./values.mjs";
import { binary as primitiveBinary } from "./numeric.mjs";

const OWN = (object, key) => Object.hasOwn(object, key);
const MAX_HEAP = 100000;

export class RuntimeHeap {
  resolveType(type, frame = this.state.frames.at(-1)) {
    return substitute(type, frame?.typeArgs ?? {});
  }
  acceptsType(expected, actual) {
    return subtype(actual, expected, this.program.types ?? {});
  }
  functionType(signature) {
    if (signature.scene && this.program.profile === "bifoil-vm.v1")
      return {
        kind: "function",
        params: signature.params.map((p) => p.ty),
        result: signature.result,
        suspend: signature.suspend,
      };
    return signatureType(signature);
  }
  closureType(signature, frame) {
    const parameters = Object.fromEntries(
      (signature.generics ?? []).map(({ name }) => [name, { kind: "parameter", name }]),
    );
    // Close outer parameters now; this declaration's parameters remain a
    // callable template until a specialize instruction supplies their types.
    return substitute(this.functionType(signature), { ...frame.typeArgs, ...parameters });
  }
  valueType(v) {
    // A safe exposed view does not replace the target's reified identity.
    if (v.kind === "function" || v.kind === "scene") return functionValueType(this, v);
    if (v.type) return v.type;
    return { kind: v.kind };
  }
  validValue(v) {
    if (!v || typeof v !== "object") return false;
    if (
      v.type !== undefined &&
      ["int", "float", "boolean", "string", "char", "unit", "null"].includes(v.kind) &&
      !sameType(v.type, { kind: v.kind })
    )
      return false;
    switch (v.kind) {
      case "int":
        return Number.isInteger(v.value) && v.value >= -2147483648 && v.value <= 2147483647;
      case "float":
        return Number.isFinite(v.value);
      case "boolean":
        return typeof v.value === "boolean";
      case "string":
        return scalarString(v.value);
      case "char":
        return isSingleScalar(v.value);
      case "unit":
      case "null":
        return v.value === null;
      case "range":
        return (
          v.type?.kind === "named" &&
          ["IntRange", "IntProgression"].includes(v.type.name) &&
          Array.isArray(v.type.args) &&
          v.type.args.length === 0 &&
          typeof v.empty === "boolean" &&
          Number.isInteger(v.first) &&
          Number.isInteger(v.last) &&
          Number.isInteger(v.step) &&
          v.step !== 0 &&
          v.step >= -2147483647 &&
          v.step <= 2147483647 &&
          [v.first, v.last].every((n) => n >= -2147483648 && n <= 2147483647) &&
          v.empty === (v.last - v.first) * Math.sign(v.step) < 0 &&
          (v.empty || (v.last - v.first) % v.step === 0) &&
          (v.type.name !== "IntRange" || (v.step === 1 && !v.empty))
        );
      case "list":
      case "set":
      case "map":
      case "entry":
      case "data":
        return (
          Number.isInteger(v.ref) &&
          v.ref >= 0 &&
          v.ref < this.state.objects.length &&
          this.state.objects[v.ref]?.kind === v.kind &&
          sameType(v.type, this.state.objects[v.ref].type)
        );
      case "builtin":
        return (
          typeof v.name === "string" &&
          typeValid(v.type) &&
          v.type.kind === "function" &&
          (v.receiver === null ||
            (Number.isInteger(v.receiver) && v.receiver >= 0 && v.receiver < this.state.cells.length))
        );
      case "function":
      case "scene":
        return validFunctionValue(this, v);
      case "address":
        return (
          Number.isInteger(v.ref) &&
          v.ref >= 0 &&
          v.ref < this.state.objects.length &&
          this.state.objects[v.ref] &&
          v.key?.kind !== "address" &&
          this.validValue(v.key)
        );
      default:
        return false;
    }
  }
  object(v) {
    check(this.validValue(v) && Number.isInteger(v.ref), "invalid object reference");
    return this.state.objects[v.ref];
  }
  allocateObject(object) {
    check(this.state.objects.length < MAX_HEAP, "runtime object budget exceeded");
    const ref = this.state.objects.push(object) - 1;
    return { kind: object.kind, ref, type: object.type };
  }
  collectionValue(type, values = []) {
    const c = collection(type);
    check(c && c.args.length === (c.family === "Map" ? 2 : 1), "invalid collection type");
    const kind = c.family.toLowerCase();
    return this.allocateObject({ kind, type, ...(kind === "map" ? { entries: values } : { items: values }) });
  }
  convert(v, type) {
    type = this.resolveType(type);
    if (this.acceptsType(type, this.valueType(v))) return v;
    if (type.kind === "nullable") {
      if (v.kind === "null") return v;
      return this.convert(v, type.inner);
    }
    if (type.kind === "float" && v.kind === "int") return primitive("float", v.value);
    if (type.kind === "string" && v.kind === "char") return primitive("string", v.value);
    const source = collection(this.valueType(v));
    check(collection(type) && source && collection(type).family === source.family, "unsupported value conversion");
    type = reifyCollectionCopy(type, this.valueType(v), this.program.types ?? {});
    const target = collection(type);
    check(target.mutable !== source.mutable || !target.mutable, "mutable type arguments are invariant");
    const original = this.object(v);
    if (target.family === "Map") {
      const entries = [];
      const builder = { kind: "map", entries };
      for (const [key, value] of original.entries) {
        const converted = this.convert(key, target.args[0]);
        check(findKey(this, builder, converted) < 0, "conversion produced a duplicate map key");
        entries.push([converted, this.convert(value, target.args[1])]);
      }
      return this.collectionValue(type, entries);
    }
    const items = original.items.map((item) => this.convert(item, target.args[0]));
    if (target.family !== "Set") return this.collectionValue(type, items);
    const unique = { kind: "set", items: [] };
    for (const item of items) {
      if (findKey(this, unique, item) < 0) unique.items.push(item);
    }
    return this.collectionValue(type, unique.items);
  }
  equal(a, b, exact = false) {
    return structuralEqual(this, a, b, exact);
  }
  binary(operator, a, b) {
    if (["==", "!=", "===", "!=="].includes(operator)) {
      const eq = this.equal(a, b, operator.length === 3);
      return primitive("boolean", operator.startsWith("!") ? !eq : eq);
    }
    if (operator === "in" || operator === "!in") {
      const found = this.contains(b, a);
      return primitive("boolean", operator === "in" ? found : !found);
    }
    if (["<", "<=", ">", ">="].includes(operator)) {
      if (a.kind === "char") a = primitive("string", a.value);
      if (b.kind === "char") b = primitive("string", b.value);
    }
    return primitiveBinary(operator, a, b);
  }
  contains(container, item) {
    if (container.kind === "range") {
      if (item.kind !== "int" || container.empty) return false;
      if (container.type.name === "IntRange") return item.value >= container.first && item.value <= container.last;
      // Preserve the selected Iterable.indexOf result and overflow boundary
      // without blocking the host while visiting billions of integer elements.
      // Int32 endpoint differences and progression counts are exact in binary64.
      const distance = (item.value - container.first) * Math.sign(container.step);
      const width = (container.last - container.first) * Math.sign(container.step);
      if (width < 0) return false;
      const step = Math.abs(container.step);
      const count = Math.floor(width / step) + 1;
      const found = distance >= 0 && distance <= width && distance % step === 0;
      const index = found ? distance / step : count - 1;
      check(index <= 2147483647, "progression search index overflow");
      return found;
    }
    if (container.kind === "string") return item.kind === "char" && container.value.includes(item.value);
    const object = this.object(container);
    if (container.kind === "map" || container.kind === "set") return findKey(this, object, item) >= 0;
    return object.items.some((value) => this.equal(value, item));
  }
  cellId(env, name) {
    for (let id = env; id !== null; id = this.state.envs[id].parent) {
      if (OWN(this.state.envs[id].bindings, name)) return this.state.envs[id].bindings[name];
    }
    return null;
  }
  cell(env, name) {
    const id = this.cellId(env, name);
    if (id !== null) return this.state.cells[id];
    const fn = this.program.profile !== "bifoil-vm.v1" && rootFunction(this.program, name);
    if (fn)
      return {
        ty: this.functionType(fn.signature),
        mutable: false,
        initialized: true,
        value: { kind: fn.signature.scene ? "scene" : "function", id: name, env: 0 },
      };
    throw new BifoilError("uninitialized or unknown binding " + name);
  }
  declare(env, name, ty, mutable, v) {
    const resolved = this.state.frames.length ? this.resolveType(ty) : ty;
    this.declareCell(env, name, resolved, mutable, v);
  }
  declareCell(env, name, ty, mutable, v) {
    check(this.state.cells.length < MAX_HEAP, "runtime heap budget exceeded");
    check(
      !OWN(this.state.envs[env].bindings, name) &&
        !(env === 0 && this.program.profile !== "bifoil-vm.v1" && rootFunction(this.program, name)),
      "duplicate runtime binding " + name,
    );
    check(this.validValue(v) && this.acceptsType(ty, this.valueType(v)), "binding type mismatch for " + name);
    const id = this.state.cells.push({ ty, mutable, initialized: true, value: v }) - 1;
    Object.defineProperty(this.state.envs[env].bindings, name, { value: id, enumerable: true, configurable: true });
  }
  captureEnvironment(env, names) {
    // Older artifacts retain their original enclosing environment.
    if (names === undefined) return env;
    const bindings = [];
    for (const name of names) {
      const id = this.cellId(env, name);
      if (id !== null) bindings.push([name, id]);
      else check(rootFunction(this.program, name), "unknown captured binding " + name);
    }
    if (!bindings.length) return 0;
    const captured = this.environment(0);
    for (const [name, id] of bindings)
      Object.defineProperty(this.state.envs[captured].bindings, name, {
        value: id,
        enumerable: true,
        configurable: true,
      });
    return captured;
  }
  environment(parent) {
    check(this.state.envs.length < MAX_HEAP, "runtime environment budget exceeded");
    return this.state.envs.push({ parent, bindings: {} }) - 1;
  }
}
