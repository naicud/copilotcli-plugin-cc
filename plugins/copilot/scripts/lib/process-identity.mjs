// Cross-platform process identity utilities for the Copilot companion, so
// shutdown logic can verify a pid's command line before signalling it without
// depending on `ps` (which does not exist on Windows). Identity/refusal
// decisions stay with the CALLER; this module only answers "is it alive?",
// "what is it running?" and performs the mechanical stop sequence.

import { execFileSync } from "node:child_process";

/**
 * Check whether a process is alive using signal 0 (no signal actually sent).
 * A pid we lack permission to signal (EPERM) still counts as alive.
 * Non-positive or non-integer pids are never alive.
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM"; // alive but owned by another user
  }
}

/**
 * Read a process's full command line, cross-platform.
 * - win32: PowerShell CIM query (`ps` is unavailable).
 * - darwin/linux: `ps -p <pid> -o command=`.
 * Returns "" for dead processes, failures, or invalid pids.
 * @param {number} pid
 * @returns {string}
 */
export function getProcessCommand(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    if (process.platform === "win32") {
      // NOTE: Windows branch has no CI coverage (no windows runner); accepted.
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
        ],
        { encoding: "utf8", timeout: 5000, windowsHide: true }
      );
      return out.trim();
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5000,
    });
    return out.trim();
  } catch {
    return "";
  }
}

/**
 * Mechanically stop a process tree leader: graceful signal, poll until
 * graceMs elapses, then SIGKILL fallback. Performs NO identity checking —
 * callers MUST verify the pid belongs to a Copilot worker first.
 * On win32 SIGTERM maps to TerminateProcess via Node, same flow applies.
 * @param {number} pid
 * @param {{ graceMs?: number, signal?: string }} [opts]
 * @returns {Promise<{ outcome: "stopped"|"alreadyDead"|"refused"|"failed", reason?: string }>}
 */
export async function stopProcessTree(pid, { graceMs = 5000, signal = "SIGTERM" } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!isProcessAlive(pid)) {
    return { outcome: "alreadyDead" };
  }
  try {
    process.kill(pid, signal);
  } catch {
    // lost the race with its own exit — fine
    return { outcome: "alreadyDead" };
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await sleep(200);
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // lost the race with its own exit — fine
    }
    await sleep(300);
  }
  return isProcessAlive(pid)
    ? { outcome: "failed", reason: `pid ${pid} survived SIGKILL` }
    : { outcome: "stopped" };
}
