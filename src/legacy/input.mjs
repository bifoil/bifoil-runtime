// Native input preparation uses the engine's tokenizer and expression evaluator.
// Prepared bounds and options are checkpointed; restoring never reevaluates them.
import { check } from "../errors.mjs";

function integerSpelling(value) {
  const parsed = Number.parseInt(value, 10);
  return !Number.isNaN(parsed) && value == parsed && value.toString() === parsed.toString();
}
function present(scene, call, input, variable) {
  scene.finished = true;
  call.paragraph(scene);
  call.wait = { kind: "input", selections: [], input, variable };
}
export function installInput(scene, call) {
  scene.input_text = (line) => {
    const { variable, inputOptions } = scene.parseInputText(line);
    present(scene, call, { kind: "text", ...inputOptions }, variable);
  };
  scene.input_number = (line) => {
    const tokens = scene.tokenizeExpr(line);
    check(tokens.length > 0, scene.lineMsg() + "input_number requires a variable and two bounds");
    const variable = scene.evaluateReference(tokens);
    check(
      scene.temps[variable] !== undefined || scene.stats[variable] !== undefined,
      scene.lineMsg() + "Non-existent variable '" + variable + "'",
    );
    check(tokens.length > 0, scene.lineMsg() + "input_number requires a minimum");
    const minimum = scene.evaluateValueToken(tokens.shift(), tokens);
    check(!Number.isNaN(minimum * 1), scene.lineMsg() + "Invalid numeric minimum");
    check(tokens.length > 0, scene.lineMsg() + "input_number requires a maximum");
    const maximum = scene.evaluateValueToken(tokens.shift(), tokens);
    check(tokens.length === 0 && !Number.isNaN(maximum * 1), scene.lineMsg() + "Invalid numeric maximum");
    check(Number.parseFloat(minimum) <= Number.parseFloat(maximum), scene.lineMsg() + "Minimum exceeds maximum");
    present(
      scene,
      call,
      {
        kind: "number",
        minimum: String(minimum),
        maximum: String(maximum),
        integer: integerSpelling(minimum) && integerSpelling(maximum),
        allow_blank: false,
      },
      variable,
    );
  };
}
export function submitInput(scene, call, wait, response) {
  check(typeof response === "string", "native input requires text");
  const input = wait.input;
  let value = response,
    feedback = null;
  if (response === "" && !input.allow_blank) feedback = "Don't just leave it blank! Type something!";
  if (input.kind === "number" && feedback === null) {
    value = Number.parseFloat(response);
    if (Number.isNaN(value)) feedback = "Please type in a number.";
    else if (input.integer && !integerSpelling(response)) feedback = "Please type in an integer number.";
    else if (value < input.minimum * 1) feedback = "Please use a number greater than or equal to " + input.minimum;
    else if (value > input.maximum * 1) feedback = "Please use a number less than or equal to " + input.maximum;
  } else if (input.kind === "text") value = response.trim().replace(/\n/g, "[n/]");
  if (feedback !== null) {
    call.wait = { ...wait, input: { ...input, feedback } };
    return;
  }
  if (scene.nav)
    scene.nav.bugLog.push(
      "*input_" +
        (input.kind === "text" ? "text" : "number") +
        " " +
        wait.variable +
        " " +
        (input.kind === "text" ? value : response),
    );
  scene.setVar(wait.variable, value);
  scene.finished = false;
  scene.resetPage();
}
export function validateInput(input) {
  check(
    input && ["text", "number"].includes(input.kind) && typeof input.allow_blank === "boolean",
    "invalid native input descriptor",
  );
  check(input.feedback === undefined || typeof input.feedback === "string", "invalid native input feedback");
  if (input.kind === "text") check(typeof input.long === "boolean", "invalid native text options");
  else
    check(
      typeof input.minimum === "string" &&
        typeof input.maximum === "string" &&
        !Number.isNaN(input.minimum * 1) &&
        !Number.isNaN(input.maximum * 1) &&
        Number.parseFloat(input.minimum) <= Number.parseFloat(input.maximum) &&
        typeof input.integer === "boolean",
      "invalid native number options",
    );
}
