/** Map controlled dependencies to virtual modules, keeping mock code out of source coverage. */
import { registerHooks } from "node:module";
let sequence = 0;
export function mockModule(t, specifier, { exports }) {
  const key = String(specifier),
    id = "__bifoil_mock_" + ++sequence;
  globalThis[id] = exports;
  const source =
    "const values = globalThis[" +
    JSON.stringify(id) +
    "];\n" +
    Object.keys(exports)
      .map((name) =>
        name === "default"
          ? "export default values.default;"
          : "export const " + name + " = values[" + JSON.stringify(name) + "];",
      )
      .join("\n");
  const url = "data:text/javascript," + encodeURIComponent(source);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === key) return { url, shortCircuit: true };
      const result = next(specifier, context);
      return result.url === key ? { url, shortCircuit: true } : result;
    },
  });
  t.after(() => {
    hooks.deregister();
    delete globalThis[id];
  });
}
