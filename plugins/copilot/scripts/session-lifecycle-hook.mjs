#!/usr/bin/env node

// Session lifecycle hook for the Copilot companion (SessionEnd).
// Settles job records whose worker is gone — so nothing keeps looking
// "running" after the session that owned it ended — and runs the disk
// hygiene sweep. Never blocks the session: every error is swallowed.

import process from "node:process";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, upsertJob } from "./lib/state.mjs";
import { isProcessAlive } from "./lib/process-identity.mjs";

const event = process.argv[2];

async function main() {
  if (event !== "SessionEnd") return;
  const workspace = await resolveWorkspace();
  for (const job of loadState(workspace).jobs ?? []) {
    if (job.status !== "running") continue;
    // Background companion tasks run in a detached node worker (pid); MCP
    // delegations in a copilot worker (workerPid). Either alive means the
    // job is genuinely still working.
    const pids = [job.pid, job.workerPid].filter((p) => Number.isInteger(p));
    if (pids.length === 0 || pids.some((p) => isProcessAlive(p))) continue;
    upsertJob(workspace, {
      id: job.id,
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: "Session ended while job was running",
      workerPid: null,
    });
  }
  try {
    const { sweepStateDirs } = await import("./lib/hygiene.mjs");
    sweepStateDirs();
  } catch {}
}

main().catch(() => process.exit(0));
