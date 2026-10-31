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
