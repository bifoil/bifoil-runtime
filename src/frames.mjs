// Call frames and ordered argument/default/variadic binding.
import { check } from "./errors.mjs";
import { RuntimeHeap } from "./heap.mjs";
const OWN = (object, key) => Object.hasOwn(object, key);

export class RuntimeFrames extends RuntimeHeap {
  pushCall(callable, args, names, { direct, boot = false, spreads = [], typeArgs = {} }) {
    check(
      this.validValue(callable) && ["function", "scene", "builtin"].includes(callable.kind),
      "value is not callable",
    );
    if (callable.kind === "builtin") {
      const result = this.invokeBuiltin(callable, args, names, direct);
      this.state.frames.at(-1).stack.push(result);
      return;
    }
    check(this.state.frames.length < 1024, "runtime call-depth budget exceeded");
    const fn = this.program.functions[callable.id];
    const resolved = { ...(callable.typeArgs ?? {}), ...typeArgs };
    const env = fn.init ? 0 : this.environment(callable.env);
    const bound = new Set(),
      groups = [];
    const variadic = fn.signature.params.at(-1)?.vararg ? fn.signature.params.length - 1 : -1;
    const frame = {
      function: callable.id,
      pc: 0,
      env,
      stack: [],
      choice: [],
      iterators: {},
      typeArgs: resolved,
      proseBase: this.state.prose.length,
    };
    this.state.frames.push(frame);
    if (callable.receiver !== undefined) {
      const receiver = this.state.cells[callable.receiver].value;
      this.declare(env, "this", this.valueType(receiver), false, receiver);
    }
    let namedIndices;
    args.forEach((argument, position) => {
      const name = names[position];
      let index;
      if (name === null) index = variadic < 0 ? position : Math.min(position, variadic);
      else {
        namedIndices ??= new Map(fn.signature.params.map((parameter, index) => [parameter.name, index]));
        index = namedIndices.get(name) ?? -1;
      }
      check(name === null || direct, "function values require positional arguments");
      const parameter = fn.signature.params[index];
      check(
        parameter && (!bound.has(index) || (index === variadic && name === null)),
        "unknown or duplicate runtime argument",
      );
      bound.add(index);
      if (index === variadic) {
        if (spreads[position] || name !== null) {
          check(argument.kind === "list", "variadic spread/group requires List");
          for (const item of this.object(argument).items) groups.push(item);
        } else groups.push(argument);
      } else this.declare(env, parameter.name, this.resolveType(parameter.ty, frame), parameter.mutable, argument);
    });
    fn.signature.params.forEach((p, i) => {
      if (i === variadic) {
        const element = this.resolveType(p.ty, frame);
        const type = { kind: "named", name: "List", args: [element] };
        this.declare(env, p.name, type, p.mutable, this.collectionValue(type, groups));
        return;
      }
      check(bound.has(i) || (p.default && (direct || boot)), "missing argument " + p.name);
    });
  }
}
