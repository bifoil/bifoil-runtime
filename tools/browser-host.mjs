// Original acceptance host. The supplied engine renders every game control;
// saved execution is restored before starting any new story evaluation.
import { installChoiceScript } from "/runtime/src/choicescript.mjs";
import { loadCompiledProgram } from "/runtime/src/packages.mjs";
import { readPresentation, savePresentation } from "/browser-save.mjs";

const status = document.getElementById("status");
const restartButton = document.getElementById("restart");
const nativeBaseUrl = window.Scene.baseUrl;
const saveButton = document.getElementById("save");
const loadButton = document.getElementById("load");
const fixture = document.getElementById("fixture");
const fixtureSources = new Map([
  ["browser", "/fixtures/browser.json"],
  ["browser-native", "/fixtures/browser-native.json"],
  ["browser-output", "/fixtures/browser-output.json"],
  ["browser-package", "/package/startup.txt"],
]);
const selectionKey = "bifoil.browser.acceptance.fixture";
const storageKey = () => "bifoil.browser.acceptance." + fixture.value;
const adapter = installChoiceScript(window.Scene, { finish: updateStatus });
window.main = document.getElementById("main");
let scene, program;
const previous = localStorage.getItem(selectionKey);
if (Array.from(fixture.options).some((option) => option.value === previous)) fixture.value = previous;

function updateStatus() {
  const active = window.stats?.scene;
  if (active?.bifoilSession || active?.bifoilFailure) scene = active;
  if (scene?.bifoilSession?.machine) program = scene.bifoilSession.machine.program;
  fixture.disabled = !program;
  restartButton.disabled = !program;
  const checkpoint = scene?.stats.bifoil_checkpoint;
  saveButton.disabled = !scene?.bifoilSession?.machine || typeof checkpoint !== "string";
  loadButton.disabled = !program || !localStorage.getItem(storageKey());
  status.textContent = checkpoint
    ? "Waiting for input"
    : scene?.bifoilSession?.machine?.state.done
      ? "Finished"
      : "Running";
}
function clearPresentation() {
  window.main.replaceChildren(Object.assign(document.createElement("div"), { id: "text" }));
}
function restoreCheckpoint(saved) {
  const { checkpoint, presentation } = readPresentation(saved);
  const session = adapter.attach(scene, program, checkpoint);
  clearPresentation();
  if (presentation !== null) window.main.innerHTML = presentation;
  session.run();
}
async function handle(operation) {
  try {
    await operation();
    updateStatus();
  } catch (error) {
    status.textContent = error.message;
    console.error(error);
  }
}
async function loadFixture() {
  const packaged = fixture.value === "browser-package";
  program = null;
  updateStatus();
  const sourceUrl = fixtureSources.get(fixture.value);
  if (!sourceUrl) throw new Error("Unknown original browser fixture");
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error("Cannot load original browser fixture");
  const source = packaged ? await response.text() : null;
  const loaded = packaged ? null : await response.json();
  if (scene) adapter.detach(scene);
  program = loaded;
  window.nav = new window.SceneNavigator(["startup"]);
  window.stats = { calls: 0, answer: "" };
  window.nav.setStartingStatsClone(window.stats);
  scene = new window.Scene("startup", window.stats, window.nav);
  window.stats.scene = scene;
  clearPresentation();
  const checkpoint = localStorage.getItem(storageKey());
  window.Scene.baseUrl = packaged ? "/package" : nativeBaseUrl;
  if (checkpoint) {
    if (packaged)
      program = await loadCompiledProgram(source, async (name) => {
        const chunk = await fetch("/package/" + name + ".txt");
        if (!chunk.ok) throw new Error("Cannot load compiled code scene");
        return chunk.text();
      });
    restoreCheckpoint(checkpoint);
  } else if (packaged) {
    scene.loadLines(source);
    scene.execute();
  } else scene.runCommand("*bifoil " + JSON.stringify(program));
}
fixture.addEventListener("change", () =>
  handle(async () => {
    localStorage.setItem(selectionKey, fixture.value);
    await loadFixture();
  }),
);
document.getElementById("restart").addEventListener("click", () =>
  handle(() => {
    adapter.detach(scene);
    clearPresentation();
    scene.stats.calls = 0;
    scene.stats.answer = "";
    adapter.attach(scene, program).run();
  }),
);
saveButton.addEventListener("click", () =>
  handle(() => {
    localStorage.setItem(storageKey(), savePresentation(scene.bifoilSession.save(), window.main));
  }),
);
loadButton.addEventListener("click", () =>
  handle(() => {
    const checkpoint = localStorage.getItem(storageKey());
    if (!checkpoint) throw new Error("No saved checkpoint");
    restoreCheckpoint(checkpoint);
  }),
);
new MutationObserver(updateStatus).observe(window.main, { childList: true, subtree: true });
window.addEventListener("error", (event) => {
  status.textContent = event.message;
});
await handle(loadFixture);
