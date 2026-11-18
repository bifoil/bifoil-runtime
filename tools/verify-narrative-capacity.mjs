// Verify reachable large narrative code and every routed same-build restored wait.
// Only compact hashes/counts are printed; narrative bodies remain in artifacts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readCompiledProgram } from "../src/node-program.mjs";
import { VM } from "../src/vm.mjs";
import { packageCodeStats } from "../src/program-code.mjs";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function settle(machine, result = machine.run()) {
  while (result.status === "running" || result.status === "loading") {
    if (result.status === "loading") await result.ready;
    result = machine.run();
  }
  return result;
}

export async function verifyNarrativeCapacity(path, config) {
  assert.ok(Number.isInteger(config.scenes) && config.scenes > 0 && config.scenes <= 1022);
  assert.ok(Number.isInteger(config.rows) && config.rows > 0 && config.rows <= 100000);
  assert.ok(Array.isArray(config.rooms) && config.rooms.length > 0 && config.rooms.length <= 3);

  function paragraphHash(room) {
    const index = String(room).padStart(4, "0");
    const hash = createHash("sha256").update("begin" + index);
    for (let remaining = config.rows; remaining > 0; remaining -= 1024)
      hash.update(" x".repeat(Math.min(1024, remaining)));
    hash.update(" " + (room === config.edited_room ? "End" : "end") + index);
    return hash.digest("hex");
  }

  function codeResidency(program, { unopened = false } = {}) {
    const stats = packageCodeStats(program);
    assert.ok(stats, "the capacity package must retain on-demand code loading");
    assert.equal(stats.pendingModules, 0);
    if (unopened) {
      assert.equal(stats.loads, 0);
      assert.equal(stats.residentModules, 0);
      assert.equal(stats.residentBytes, 0);
    } else {
      // This route uses only initialization, routing, and one room. These limits
      // describe this workload, not the language's general runtime heap budget.
      assert.ok(stats.loads <= 3);
      assert.ok(stats.residentModules <= 3);
      assert.ok(stats.residentBytes <= 2 * 1024 * 1024);
    }
    return stats;
  }

  const checked = [];
  for (const room of config.rooms) {
    assert.ok(Number.isInteger(room) && room >= 0 && room < config.scenes);
    let program = await readCompiledProgram(path);
    const residency = [codeResidency(program, { unopened: true })];
    assert.equal(Object.keys(program.modules).length, config.scenes + 2);
    for (let index = 0; index < config.scenes; index++)
      assert.ok(Object.hasOwn(program.functions, "rooms.r" + String(index).padStart(4, "0") + ".enter"));
    let machine = new VM(program);
    let result = await settle(machine);
    assert.equal(result.status, "waiting");
    const grouped = config.routing_group_size !== undefined && config.routing_group_size !== null;
    if (grouped) assert.equal(config.routing_group_size, 128);
    const count = grouped ? Math.ceil(config.scenes / 128) : config.scenes;
    assert.deepEqual(
      result.options,
      Array.from({ length: count }, (_, index) => ({
        label: (grouped ? "Group " : "Room ") + String(index).padStart(4, "0"),
        enabled: true,
      })),
    );
    assert.deepEqual(machine.state.transcript, []);
    residency.push(codeResidency(program));
    const before = machine.save();
    program = await readCompiledProgram(path);
    residency.push(codeResidency(program, { unopened: true }));
    machine = VM.restore(program, before);
    result = await settle(machine, machine.choose(grouped ? Math.floor(room / 128) : room));
    if (grouped) {
      assert.equal(result.status, "waiting");
      const first = Math.floor(room / 128) * 128;
      assert.deepEqual(
        result.options,
        Array.from({ length: Math.min(128, config.scenes - first) }, (_, index) => ({
          label: "Room " + String(first + index).padStart(4, "0"),
          enabled: true,
        })),
      );
      assert.deepEqual(machine.state.transcript, []);
      residency.push(codeResidency(program));
      const route = machine.save();
      program = await readCompiledProgram(path);
      residency.push(codeResidency(program, { unopened: true }));
      machine = VM.restore(program, route);
      result = await settle(machine, machine.choose(room % 128));
    }
    assert.equal(result.status, "waiting");
    assert.deepEqual(result.options, [{ label: "Return 1", enabled: true }]);
    assert.equal(machine.state.transcript.length, 1);
    const text = machine.state.transcript[0];
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    assert.equal(digest, paragraphHash(room));
    assert.equal(text.length, 17 + 2 * config.rows);
    residency.push(codeResidency(program));
    const during = machine.save();
    assert.ok(machine.state.frames.length >= 2);
    const frames = machine.state.frames.length;
    program = await readCompiledProgram(path);
    residency.push(codeResidency(program, { unopened: true }));
    machine = VM.restore(program, during);
    result = await settle(machine, machine.choose(0));
    assert.equal(result.status, "done");
    assert.equal(machine.state.transcript.length, 2);
    assert.equal(createHash("sha256").update(machine.state.transcript[0], "utf8").digest("hex"), digest);
    assert.equal(machine.state.transcript[1], "Finished 1");
    residency.push(codeResidency(program));
    checked.push({
      code_residency_observations: residency,
      room,
      paragraph_sha256: digest,
      rows: config.rows,
      restored_waits: grouped ? 3 : 2,
      scene_frames_at_wait: frames,
      root_checkpoint_units: before.length,
      room_checkpoint_units: during.length,
    });
  }
  return { passed: true, compiled_modules: config.scenes + 2, checked };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path, configPath] = process.argv.slice(2);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  console.log(JSON.stringify(await verifyNarrativeCapacity(path, config)));
}
