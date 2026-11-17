// Fetch only validated package scene names; never execute their native commands.
// Stream decoding enforces the same byte ceiling as the filesystem reader.
import { check } from "./errors.mjs";
import { validCodeScene } from "./package-format.mjs";

export async function readBrowserCode(Scene, name) {
  check(validCodeScene(name), "invalid compiled code scene name");
  check(typeof globalThis.fetch === "function", "compiled package requires fetch or a readChunk hook");
  const base = typeof Scene.baseUrl === "string" ? Scene.baseUrl.replace(/\/$/, "") : "scenes";
  const response = await globalThis.fetch(base + "/" + name + ".txt");
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    check(false, "cannot load compiled code scene: " + name);
  }
  const limit = 16 * 1024 * 1024;
  const reported = Number(response.headers.get("content-length"));
  if (Number.isFinite(reported) && reported > limit) {
    await response.body?.cancel().catch(() => {});
    check(false, "compiled scene size budget exceeded");
  }
  check(response.body?.getReader, "compiled package requires streaming scene reads");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const parts = [];
  let total = 0,
    completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      total += value.byteLength;
      check(total <= limit, "compiled scene size budget exceeded");
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
