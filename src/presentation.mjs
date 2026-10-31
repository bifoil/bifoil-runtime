// Default ChoiceScript presentation. The native renderer may append its submit
// button beside the form. Remove only nodes created for the consumed input.
import { BifoilError } from "./errors.mjs";

export function print(scene, text) {
  scene.accumulatedParagraph.push(text);
  scene.paragraph();
}
function controls(parent) {
  return Array.from(parent?.childNodes ?? parent?.querySelectorAll?.("form") ?? []);
}
function presentControls(scene, parent, render, respond) {
  const existing = new Set(controls(parent));
  let owned = [];
  const remove = () => owned.forEach((node) => node.remove());
  render((response) => {
    try {
      const result = respond(response);
      remove();
      return result;
    } catch (error) {
      if (scene.bifoilSession?.machine.failure) remove();
      throw error;
    }
  });
  owned = controls(parent).filter((node) => !existing.has(node));
}
export function renderChoice(scene, options, select) {
  if (typeof globalThis.printOptions !== "function")
    throw new BifoilError("ChoiceScript printOptions host hook required");
  scene.paragraph();
  const parent = globalThis.main ?? globalThis.document?.getElementById("main");
  presentControls(
    scene,
    parent,
    (respond) => {
      // renderOptions would expand ChoiceScript variables in already formatted labels.
      globalThis.printOptions(
        [""],
        options.map((option, index) => ({
          name: option.label,
          group: "",
          line: index,
          endLine: index,
          unselectable: !option.enabled,
        })),
        (option) => respond(option.line),
      );
    },
    select,
  );
}
export function renderInput(scene, input, submit, printOutput = print) {
  if (typeof globalThis.printInput !== "function") throw new BifoilError("ChoiceScript printInput host hook required");
  if (input.feedback) {
    if (typeof globalThis.asyncAlert === "function") globalThis.asyncAlert(input.feedback);
    else printOutput(scene, input.feedback);
  }
  const parent = scene.target ?? globalThis.document?.getElementById("text");
  presentControls(
    scene,
    parent,
    (respond) => {
      globalThis.printInput(
        scene.target,
        {
          long: input.long ?? false,
          allow_blank: input.allow_blank,
          numeric: input.kind === "number",
        },
        (response) => respond(String(response)),
        input.minimum,
        input.maximum,
        input.integer ? 1 : undefined,
      );
    },
    submit,
  );
}
