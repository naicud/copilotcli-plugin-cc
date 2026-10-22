// Process utilities for the Copilot companion.

import { spawn } from "node:child_process";

/**
 * Run a command and return { stdout, stderr, exitCode }.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        windowsHide: true,
      });
    } catch (err) {
      resolve({ stdout: "", stderr: String(err?.message ?? err), exitCode: 127 });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }, opts.timeoutMs)
      : null;
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr: stderr || String(err?.message ?? err), exitCode: 127 });
    });
    proc.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
  });
}

/**
 * Spawn a detached background process.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnDetached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: "ignore",
    detached: true,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    windowsHide: true,
  });
  child.unref();
  return child;
}
