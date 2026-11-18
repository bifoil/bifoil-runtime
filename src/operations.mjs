import { findKey } from "./collection-index.mjs";
import { joinText } from "./text.mjs";
import { BifoilError, check } from "./errors.mjs";
import { collection } from "./types.mjs";
import { value, int, nullValue as nil } from "./values.mjs";

function executeSpecialize(machine, instruction, frame, pop) {
  const stack = frame.stack;
  const callable = pop();
  const args = Object.fromEntries(
    Object.entries(instruction.args).map(([name, type]) => [name, machine.resolveType(type, frame)]),
  );
  const typeArgs = { ...callable.typeArgs, ...args };
  stack.push({
    ...callable,
    typeArgs,
    type: machine.resolveType(machine.functionType(machine.program.functions[callable.id].signature), { typeArgs }),
  });
}

function executeConstruct(machine, instruction, frame) {
  const stack = frame.stack;
  const type = machine.resolveType(instruction.ty),
    definition = machine.program.types?.[type.name];
  check(definition && stack.length >= instruction.fields.length, "unknown data constructor");
  const values = stack.splice(stack.length - instruction.fields.length, instruction.fields.length),
    fields = {};
  const typeArgs = Object.fromEntries((definition.parameters ?? []).map((p, i) => [p.name, type.args[i]]));
  instruction.fields.forEach((name, index) => {
    const raw = definition.fields[name],
      field = raw && { ...raw, ty: machine.resolveType(raw.ty, { typeArgs }) };
    check(field && machine.acceptsType(field.ty, machine.valueType(values[index])), "invalid data field");
    check(machine.state.cells.length < 100000, "runtime heap budget exceeded");
    Object.defineProperty(fields, name, {
      value:
        machine.state.cells.push({
          ty: field.ty,
          mutable: field.mutable,
          initialized: true,
          value: values[index],
        }) - 1,
      enumerable: true,
    });
  });
  stack.push(machine.allocateObject({ kind: "data", type, fields, tag: instruction.tag }));
}

function executeAddressMember(machine, instruction, frame, pop) {
  const stack = frame.stack;
  const receiver = pop();
  check(receiver.kind === "data", "field assignment requires data");
  const object = machine.object(receiver),
    cell = machine.state.cells[object.fields[instruction.name]];
  check(cell?.mutable, "field is immutable");
  stack.push({ kind: "address", ref: receiver.ref, key: value("string", instruction.name) });
}

function executeFunctionValue(machine, instruction, frame) {
  const stack = frame.stack;
  check(Object.hasOwn(machine.program.functions, instruction.function), "unknown anonymous function");
  stack.push({
    kind: "function",
    id: instruction.function,
    env: machine.captureEnvironment(frame.env, instruction.captures),
    typeArgs: { ...frame.typeArgs },
  });
}

function executeProseStart(machine) {
  machine.flushProse();
  machine.state.prose.push("");
}

function executeProseText(machine, _instruction, _frame, pop) {
  const text = pop();
  check(text.kind === "string" && machine.state.prose.length, "invalid prose text");
  const index = machine.state.prose.length - 1;
  machine.state.prose[index] = joinText(
    [machine.state.prose[index], text.value],
    machine.state.prose[index].length ? " " : "",
  );
}

function executeProseFlush(machine) {
  machine.flushProse(machine.state.prose.length - 1);
}

function executeProseEnd(machine) {
  machine.closeProse(machine.state.prose.length - 1);
}

function executeProseUnwind(machine, instruction, frame) {
  machine.closeProse((frame.proseBase ?? 0) + instruction.depth);
}

function executeConvert(machine, instruction, frame, pop) {
  const stack = frame.stack;
  stack.push(machine.convert(pop(), instruction.ty));
}

function executeMember(machine, instruction, frame, pop) {
  const stack = frame.stack;
  stack.push(machine.getMember(pop(), instruction.name, machine.resolveType(instruction.ty), instruction.function));
}

function executeIndex(machine, _instruction, frame, pop) {
  const stack = frame.stack;
  const key = pop(),
    receiver = pop();
  stack.push(machine.getIndex(receiver, key));
}

function executeAssertPresent(_machine, _instruction, frame, pop) {
  const stack = frame.stack;
  const v = pop();
  check(v.kind !== "null", "non-null assertion failed");
  stack.push(v);
}

function executeTypeTest(machine, instruction, frame, pop) {
  const stack = frame.stack;
  const v = pop(),
    match = machine.acceptsType(machine.resolveType(instruction.ty), machine.valueType(v));
  if (instruction.op === "type_test") stack.push(value("boolean", instruction.negate ? !match : match));
  else if (match) stack.push(v);
  else if (instruction.safe) stack.push(nil());
  else throw new BifoilError("checked cast failed");
}

function executeJumpNull(_machine, instruction, frame, pop) {
  if ((pop().kind === "null") === instruction.when_null) frame.pc = instruction.target;
}

function executeBeginCollection(machine, instruction, frame) {
  const stack = frame.stack;
  stack.push(machine.collectionValue(machine.resolveType(instruction.ty)));
}

function executeCheckKey(machine, _instruction, frame) {
  const stack = frame.stack;
  const key = stack.at(-1),
    builder = machine.object(stack.at(-2));
  check(findKey(machine, builder, key) < 0, "duplicate map key");
}

function executeCollectionPut(machine, _instruction, frame, pop) {
  const stack = frame.stack;
  const item = pop(),
    key = pop(),
    builder = machine.object(stack.at(-1));
  builder.entries.push([key, item]);
}

function executeCollectionAdd(machine, _instruction, frame, pop) {
  const stack = frame.stack;
  const item = pop(),
    builder = machine.object(stack.at(-1));
  if (builder.kind !== "set" || findKey(machine, builder, item) < 0) builder.items.push(item);
}

function executeAddressIndex(machine, _instruction, frame, pop) {
  const stack = frame.stack;
  const key = pop(),
    receiver = pop(),
    c = collection(machine.valueType(receiver));
  check(c?.mutable && ["list", "map"].includes(receiver.kind), "invalid indexed update");
  stack.push({ kind: "address", ref: receiver.ref, key });
}

function executeReadAddress(machine, _instruction, frame) {
  const stack = frame.stack;
  stack.push(machine.readAddress(stack.at(-1)));
}

function executeWriteAddress(machine, _instruction, _frame, pop) {
  const v = pop();
  machine.writeAddress(pop(), v);
}

function executeRange(_machine, instruction, frame, pop) {
  const stack = frame.stack;
  const end = pop(),
    start = pop();
  check(start.kind === "int" && end.kind === "int", "range bounds require Int");
  check(
    instruction.descending || (instruction.exclusive ? start.value < end.value : start.value <= end.value),
    "ascending range is empty or reversed",
  );
  stack.push({
    kind: "range",
    type: { kind: "named", name: instruction.descending ? "IntProgression" : "IntRange", args: [] },
    first: start.value,
    last: end.value - (instruction.exclusive ? 1 : 0),
    step: instruction.descending ? -1 : 1,
    empty: instruction.descending && start.value < end.value,
  });
}

function executeRangeStep(_machine, _instruction, frame, pop) {
  const stack = frame.stack;
  const step = pop(),
    range = pop();
  check(range.kind === "range" && step.kind === "int" && step.value > 0, "range step must be a positive Int");
  const direction = Math.sign(range.step),
    last = range.empty
      ? range.last
      : range.first + direction * Math.floor(Math.abs(range.last - range.first) / step.value) * step.value;
  stack.push({
    ...range,
    type: { kind: "named", name: "IntProgression", args: [] },
    step: direction * step.value,
    last,
  });
}

function executeIterStart(machine, instruction, frame, pop) {
  const iterable = pop();
  frame.iterators ??= {};
  if (iterable.kind === "range")
    frame.iterators[instruction.id] = { range: iterable, current: iterable.first, done: iterable.empty };
  else if (iterable.kind === "string")
    frame.iterators[instruction.id] =
      machine.program.profile === "bifoil-vm.v1"
        ? { items: Array.from(iterable.value, (c) => value("char", c)), index: 0 }
        : { kind: "string", text: iterable.value, offset: 0 };
  else {
    const object = machine.object(iterable);
    const items =
      iterable.kind === "map"
        ? object.entries.map(([key, value]) =>
            machine.allocateObject({
              kind: "entry",
              type: { kind: "named", name: "Entry", args: iterable.type.args },
              key,
              value,
            }),
          )
        : [...object.items];
    frame.iterators[instruction.id] = { items, index: 0 };
  }
}

function executeIterNext(machine, instruction, frame) {
  const iterator = frame.iterators?.[instruction.id];
  check(iterator, "missing loop traversal");
  let next;
  if (iterator.range) {
    if (iterator.done) {
      frame.pc = instruction.target;
      return;
    }
    next = int(iterator.current);
    if (iterator.current === iterator.range.last) iterator.done = true;
    else iterator.current += iterator.range.step;
  } else if (iterator.kind === "string") {
    if (iterator.offset >= iterator.text.length) {
      frame.pc = instruction.target;
      return;
    }
    const character = String.fromCodePoint(iterator.text.codePointAt(iterator.offset));
    iterator.offset += character.length;
    next = value("char", character);
  } else {
    if (iterator.index >= iterator.items.length) {
      frame.pc = instruction.target;
      return;
    }
    next = iterator.items[iterator.index++];
  }
  machine.declare(frame.env, instruction.name, instruction.ty, false, next);
}

function executeIterEnd(_machine, instruction, frame) {
  if (frame.iterators) delete frame.iterators[instruction.id];
}

function executeStackMark(_machine, instruction, frame) {
  const stack = frame.stack;
  check(Number.isSafeInteger(instruction.id) && instruction.id >= 0, "invalid loop stack mark");
  const marks = (frame.loopMarks ??= []);
  check(!marks.some((mark) => mark.id === instruction.id), "duplicate loop stack mark");
  marks.push({ id: instruction.id, depth: stack.length });
}

function executeStackReset(_machine, instruction, frame) {
  const stack = frame.stack;
  const marks = frame.loopMarks ?? [];
  const index = marks.findIndex((mark) => mark.id === instruction.id);
  check(index >= 0 && marks[index].depth <= stack.length, "invalid loop stack reset");
  stack.length = marks[index].depth;
  marks.length = index + 1;
}

function executeStackEnd(_machine, instruction, frame) {
  const marks = frame.loopMarks ?? [];
  check(marks.length > 0 && marks.at(-1).id === instruction.id, "invalid loop stack end");
  marks.pop();
}

function executeUnwind(machine, instruction, frame) {
  check(Number.isInteger(instruction.count) && instruction.count >= 0, "invalid scope unwind");
  for (let i = 0; i < instruction.count; i++) {
    check(machine.state.envs[frame.env].parent !== null, "invalid scope unwind");
    frame.env = machine.state.envs[frame.env].parent;
  }
}

function executeUninitialized(machine, instruction, frame) {
  check(machine.state.cells.length < 100000, "runtime heap budget exceeded");
  check(!Object.hasOwn(machine.state.envs[frame.env].bindings, instruction.name), "duplicate binding");
  const id =
    machine.state.cells.push({
      ty: machine.resolveType(instruction.ty),
      mutable: instruction.mutable,
      initialized: false,
      value: null,
    }) - 1;
  Object.defineProperty(machine.state.envs[frame.env].bindings, instruction.name, {
    value: id,
    enumerable: true,
    configurable: true,
  });
}

function executeUnused(machine, instruction, frame) {
  const stack = frame.stack;
  stack.push(value("boolean", !Object.hasOwn(machine.state.history, instruction.site)));
}

function executeSceneCall(machine, instruction, frame, pop) {
  const stack = frame.stack;
  const args = stack.splice(stack.length - instruction.names.length, instruction.names.length),
    destination = pop();
  check(destination.kind === "scene", "destination is not a Scene");
  if (instruction.transfer) {
    let index = machine.state.frames.length - 1;
    while (index >= 0 && !machine.program.functions[machine.state.frames[index].function].signature.scene) index--;
    check(index >= 0, "transfer has no active scene visit");
    machine.closeProse(machine.state.frames[index].proseBase ?? 0);
    machine.state.frames.splice(index);
  }
  machine.pushCall(destination, args, instruction.names, { direct: instruction.direct });
}

const instructionHandlers = new Map([
  ["specialize", executeSpecialize],
  ["construct", executeConstruct],
  ["address_member", executeAddressMember],
  ["function_value", executeFunctionValue],
  ["prose_start", executeProseStart],
  ["prose_text", executeProseText],
  ["prose_flush", executeProseFlush],
  ["prose_end", executeProseEnd],
  ["prose_unwind", executeProseUnwind],
  ["convert", executeConvert],
  ["member", executeMember],
  ["index", executeIndex],
  ["assert_present", executeAssertPresent],
  ["type_test", executeTypeTest],
  ["cast", executeTypeTest],
  ["jump_null", executeJumpNull],
  ["begin_collection", executeBeginCollection],
  ["check_key", executeCheckKey],
  ["collection_put", executeCollectionPut],
  ["collection_add", executeCollectionAdd],
  ["address_index", executeAddressIndex],
  ["read_address", executeReadAddress],
  ["write_address", executeWriteAddress],
  ["range", executeRange],
  ["range_step", executeRangeStep],
  ["iter_start", executeIterStart],
  ["iter_next", executeIterNext],
  ["iter_end", executeIterEnd],
  ["stack_mark", executeStackMark],
  ["stack_reset", executeStackReset],
  ["stack_end", executeStackEnd],
  ["unwind", executeUnwind],
  ["uninitialized", executeUninitialized],
  ["unused", executeUnused],
  ["scene_call", executeSceneCall],
]);

/** Execute heap and story instructions, leaving core stack instructions to the VM. */
export function executeInstruction(machine, instruction, frame, pop) {
  const handler = instructionHandlers.get(instruction.op);
  if (!handler) return false;
  handler(machine, instruction, frame, pop);
  return true;
}
