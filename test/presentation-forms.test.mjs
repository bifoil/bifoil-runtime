import test from "node:test";
import assert from "node:assert/strict";
import { renderChoice, renderInput } from "../src/presentation.mjs";

function host(t) {
  const previous = { main: globalThis.main, printOptions: globalThis.printOptions, printInput: globalThis.printInput };
  const forms = [],
    controls = [],
    callbacks = [];
  const parent = { childNodes: controls, querySelectorAll: () => forms };
  function add(callback) {
    const form = {
      remove() {
        const index = forms.indexOf(form);
        if (index >= 0) forms.splice(index, 1);
        const position = controls.indexOf(form);
        if (position >= 0) controls.splice(position, 1);
      },
    };
    const button = {
      remove() {
        const index = controls.indexOf(button);
        if (index >= 0) controls.splice(index, 1);
      },
    };
    forms.push(form);
    controls.push(form, button);
    callbacks.push(callback);
  }
  globalThis.main = parent;
  globalThis.printOptions = (groups, options, callback) => add((option) => callback(options[option]));
  globalThis.printInput = (target, options, callback) => add(callback);
  t.after(() => Object.assign(globalThis, previous));
  return { forms, controls, callbacks, scene: { paragraph() {}, target: parent, bifoilSession: { machine: {} } } };
}
const option = [{ label: "Continue", enabled: true }];

test("consuming a choice removes only its own form when the next choice is rendered synchronously", (t) => {
  const { scene, forms, controls, callbacks } = host(t);
  const narrative = {
    remove() {
      throw new Error("existing narrative must remain");
    },
  };
  controls.push(narrative);
  renderChoice(scene, option, () => renderChoice(scene, option, () => {}));
  const previous = forms[0];
  callbacks[0](0);
  assert.equal(forms.length, 1);
  assert.notEqual(forms[0], previous);
  assert.equal(controls.length, 3);
  callbacks[1](0);
  assert.equal(forms.length, 0);
  assert.deepEqual(controls, [narrative]);
});

test("an invalid choice keeps its form available while a terminal failure removes it", (t) => {
  const { scene, forms, callbacks } = host(t);
  renderChoice(scene, option, () => {
    throw new Error("invalid choice");
  });
  assert.throws(() => callbacks[0](0), /invalid choice/);
  assert.equal(forms.length, 1);
  scene.bifoilSession.machine.failure = new Error("checked failure");
  assert.throws(() => callbacks[0](0), /invalid choice/);
  assert.equal(forms.length, 0);
});

test("consuming text input removes its form without removing a newly prepared choice", (t) => {
  const { scene, forms, callbacks } = host(t);
  let received;
  renderInput(scene, { kind: "text", allow_blank: false }, (response) => {
    received = response;
    renderChoice(scene, option, () => {});
  });
  const previous = forms[0];
  callbacks[0]("answer");
  assert.equal(received, "answer");
  assert.equal(forms.length, 1);
  assert.notEqual(forms[0], previous);
});

test("presentation checks missing hooks and handles a host without DOM controls", (t) => {
  const names = ["main", "document", "printOptions", "printInput"];
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  for (const name of names) Reflect.deleteProperty(globalThis, name);
  const scene = { paragraph() {} };
  assert.throws(() => renderChoice(scene, option, () => {}), /printOptions host hook/);
  assert.throws(() => renderInput(scene, { kind: "text" }, () => {}), /printInput host hook/);
  let selected;
  globalThis.printOptions = (_groups, items, respond) => {
    assert.equal(items[0].unselectable, true);
    selected = respond;
  };
  let received;
  renderChoice(scene, [{ label: "Unavailable", enabled: false }], (index) => {
    received = index;
  });
  selected({ line: 0 });
  assert.equal(received, 0);
});

test("input feedback and legacy form discovery preserve host options and consumed controls", (t) => {
  const names = ["document", "printInput", "asyncAlert"];
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  Reflect.deleteProperty(globalThis, "asyncAlert");
  const forms = [],
    printed = [],
    alerts = [],
    callbacks = [],
    calls = [];
  const parent = { querySelectorAll: () => forms };
  globalThis.document = {
    getElementById: (id) => {
      assert.equal(id, "text");
      return parent;
    },
  };
  globalThis.printInput = (target, options, respond, minimum, maximum, step) => {
    calls.push({ target, options, minimum, maximum, step });
    const form = {
      remove() {
        forms.splice(forms.indexOf(form), 1);
      },
    };
    forms.push(form);
    callbacks.push(respond);
  };
  const scene = { paragraph() {} };
  const replies = [];
  renderInput(
    scene,
    { kind: "number", feedback: "Try again", minimum: 1, maximum: 9, integer: true },
    (reply) => replies.push(reply),
    (_scene, text) => printed.push(text),
  );
  assert.deepEqual(printed, ["Try again"]);
  assert.deepEqual(calls[0], {
    target: undefined,
    options: { long: false, allow_blank: undefined, numeric: true },
    minimum: 1,
    maximum: 9,
    step: 1,
  });
  callbacks[0](7);
  assert.deepEqual(replies, ["7"]);
  assert.equal(forms.length, 0);
  globalThis.asyncAlert = (message) => alerts.push(message);
  renderInput(scene, { kind: "text", feedback: "Helpful feedback", long: true, allow_blank: true }, () => {});
  assert.deepEqual(alerts, ["Helpful feedback"]);
  assert.equal(calls[1].step, undefined);
  assert.deepEqual(calls[1].options, { long: true, allow_blank: true, numeric: false });
  callbacks[1]("answer");
  assert.equal(forms.length, 0);
});
