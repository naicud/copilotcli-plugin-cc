// Tests for process-identity.mjs: liveness probing, cross-platform command
// reading and the mechanical stop
// sequence (no identity checks — that belongs to the caller).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

process.env.NODE_ENV = "test";

import {
  isProcessAlive,
  getProcessCommand,
  stopProcessTree,
} from "../plugins/copilot/scripts/lib/process-identity.mjs";

/** Spawn a harmless long-lived node process; returns pid. */
function spawnSleeper() {
  const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
  return proc.pid;
}

test("isProcessAlive detects own process", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("isProcessAlive false for nonexistent pid", () => {
  assert.equal(isProcessAlive(999999999), false);
});

test("isProcessAlive safe (false) for negative pid", () => {
  assert.equal(isProcessAlive(-1), false);
});

test("getProcessCommand of own node process mentions node", { skip: process.platform === "win32" }, () => {
  // Windows branch is untested here (no CI windows runner); skip assertion.
  const cmd = getProcessCommand(process.pid);
  assert.ok(cmd.includes("node"), `expected node in command line, got: ${cmd}`);
});

test("getProcessCommand guards invalid pids without throwing", () => {
  for (const bad of [0, -5, 1.5, "x"]) {
    assert.equal(getProcessCommand(bad), "");
  }
});

test("stopProcessTree stops a real spawned sleeper", async () => {
  const pid = spawnSleeper();
  try {
    assert.equal(isProcessAlive(pid), true);
    const res = await stopProcessTree(pid, { graceMs: 5000 });
    assert.equal(res.outcome, "stopped");
    assert.equal(isProcessAlive(pid), false);
    const second = await stopProcessTree(pid);
    assert.equal(second.outcome, "alreadyDead");
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

test("stopProcessTree reports alreadyDead for invalid pid", async () => {
  const res = await stopProcessTree(-3);
  assert.equal(res.outcome, "alreadyDead");
});
