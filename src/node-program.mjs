// Filesystem loading stays outside the portable VM and ChoiceScript adapter.
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { check } from "./errors.mjs";
import { loadCompiledProgram } from "./packages.mjs";

const MAX_SCENE_BYTES = 16 * 1024 * 1024;
const READ_BUFFER_BYTES = 65536;

async function readScene(path) {
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    check(metadata.isFile(), "compiled scene must be a regular file");
    check(metadata.size <= MAX_SCENE_BYTES, "compiled scene size budget exceeded");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const parts = [];
    let total = 0;
    while (true) {
      // The extra byte detects growth after stat without an unbounded read.
      const length = Math.min(buffer.length, MAX_SCENE_BYTES - total + 1);
      const { bytesRead } = await file.read({ buffer, length });
      if (bytesRead === 0) break;
      total += bytesRead;
      check(total <= MAX_SCENE_BYTES, "compiled scene size budget exceeded");
      parts.push(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    await file.close();
  }
}

export async function readCompiledProgram(path) {
  const source = await readScene(path);
  return loadCompiledProgram(source, (scene) => readScene(join(dirname(path), scene + ".txt")), {
    digest: (json) => createHash("sha256").update(json, "utf8").digest("hex"),
  });
}
