import { keyCandidates } from "./collection-index.mjs";
// Explicit comparison frames keep deep/cyclic value graphs off the JS call stack.
// Unordered candidate trials roll back their pair trail when a match fails.
import { BifoilError } from "./errors.mjs";
import { sameType } from "./types.mjs";

class StructuralComparison {
  constructor(machine, exact) {
    this.machine = machine;
    this.exact = exact;
    this.frames = [];
    this.pairs = new Set();
    this.trail = [];
    this.result = false;
  }
  push(a, b) {
    this.frames.push({ stage: "start", a, b, waiting: false, index: 0 });
  }
  finish(result) {
    this.frames.pop();
    this.result = result;
  }
  rollback(mark) {
    while (this.trail.length > mark) this.pairs.delete(this.trail.pop());
  }
  run(a, b) {
    this.push(a, b);
    while (this.frames.length) {
      const frame = this.frames.at(-1);
      if (frame.stage === "start") this.start(frame);
      else if (frame.stage === "set") this.set(frame);
      else if (frame.stage === "map") this.map(frame);
      else this.sequence(frame);
    }
    return this.result;
  }
  start(frame) {
    const { a, b } = frame;
    if (a.kind === "null" || b.kind === "null") return this.finish(a.kind === b.kind);
    if (this.exact && !sameType(this.machine.valueType(a), this.machine.valueType(b))) return this.finish(false);
    if (["function", "builtin"].includes(a.kind) || ["function", "builtin"].includes(b.kind))
      throw new BifoilError("function equality is unavailable");
    if (a.kind === "scene" || b.kind === "scene") return this.finish(a.kind === b.kind && a.id === b.id);
    if (a.kind === "range" || b.kind === "range")
      return this.finish(
        a.kind === b.kind && ((a.empty && b.empty) || (a.first === b.first && a.last === b.last && a.step === b.step)),
      );
    if (!Number.isInteger(a.ref) || !Number.isInteger(b.ref)) {
      const compatible =
        (["char", "string"].includes(a.kind) && ["char", "string"].includes(b.kind)) ||
        (["int", "float"].includes(a.kind) && ["int", "float"].includes(b.kind)) ||
        a.kind === b.kind;
      return this.finish(compatible && a.value === b.value);
    }
    if (a.kind !== b.kind || !["list", "set", "map", "entry", "data"].includes(a.kind)) return this.finish(false);
    frame.left = this.machine.object(a);
    frame.right = this.machine.object(b);
    const { left, right } = frame;
    if (a.kind === "data" && (left.type.name !== right.type.name || left.tag !== right.tag)) return this.finish(false);
    const pair = a.ref + ":" + b.ref;
    if (a.ref === b.ref || this.pairs.has(pair)) return this.finish(true);
    this.pairs.add(pair);
    this.trail.push(pair);
    frame.stage = a.kind;
    if (a.kind === "data") {
      frame.keys = Object.keys(left.fields);
      frame.count = frame.keys.length;
      if (frame.count !== Object.keys(right.fields).length) return this.finish(false);
    } else if (a.kind === "entry") frame.count = 2;
    else if (a.kind === "map") {
      if (left.entries.length !== right.entries.length) return this.finish(false);
      frame.count = left.entries.length;
      frame.other = 0;
      frame.cursor = 0;
      frame.phase = "key";
      frame.used = new Set();
    } else {
      if (left.items.length !== right.items.length) return this.finish(false);
      frame.count = left.items.length;
      if (a.kind === "set") {
        frame.other = 0;
        frame.cursor = 0;
        frame.used = new Set();
      }
    }
  }
  sequence(frame) {
    if (frame.waiting) {
      if (!this.result) return this.finish(false);
      frame.index++;
    }
    if (frame.index === frame.count) return this.finish(true);
    frame.waiting = true;
    if (frame.stage === "list") this.push(frame.left.items[frame.index], frame.right.items[frame.index]);
    else if (frame.stage === "entry") {
      const field = frame.index === 0 ? "key" : "value";
      this.push(frame.left[field], frame.right[field]);
    } else {
      const field = frame.keys[frame.index];
      if (!Object.hasOwn(frame.right.fields, field)) return this.finish(false);
      this.push(
        this.machine.state.cells[frame.left.fields[field]].value,
        this.machine.state.cells[frame.right.fields[field]].value,
      );
    }
  }
  nextCandidate(frame, key) {
    frame.candidates ??= keyCandidates(frame.right, key);
    while (frame.cursor < frame.candidates.length && frame.used.has(frame.candidates[frame.cursor])) frame.cursor++;
    if (frame.cursor === frame.candidates.length) return false;
    frame.other = frame.candidates[frame.cursor];
    return true;
  }
  set(frame) {
    if (frame.waiting) {
      if (this.result) {
        frame.used.add(frame.other);
        frame.index++;
        frame.cursor = 0;
        frame.candidates = null;
      } else {
        this.rollback(frame.mark);
        frame.cursor++;
      }
    }
    if (frame.index === frame.count) return this.finish(true);
    if (!this.nextCandidate(frame, frame.left.items[frame.index])) return this.finish(false);
    frame.mark = this.trail.length;
    frame.waiting = true;
    this.push(frame.left.items[frame.index], frame.right.items[frame.other]);
  }
  map(frame) {
    if (frame.waiting) {
      if (frame.phase === "key") {
        this.rollback(frame.mark);
        if (this.result) {
          frame.phase = "value";
          this.push(frame.left.entries[frame.index][1], frame.right.entries[frame.other][1]);
          return;
        }
        frame.cursor++;
      } else {
        if (!this.result) return this.finish(false);
        frame.used.add(frame.other);
        frame.index++;
        frame.cursor = 0;
        frame.candidates = null;
        frame.phase = "key";
      }
    }
    if (frame.index === frame.count) return this.finish(true);
    if (!this.nextCandidate(frame, frame.left.entries[frame.index][0])) return this.finish(false);
    frame.mark = this.trail.length;
    frame.waiting = true;
    this.push(frame.left.entries[frame.index][0], frame.right.entries[frame.other][0]);
  }
}
export function structuralEqual(machine, a, b, exact = false) {
  return new StructuralComparison(machine, exact).run(a, b);
}
