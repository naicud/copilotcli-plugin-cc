// The companion behind the slash commands, and the two lifecycle hooks, run
// as real subprocesses against the fake Copilot CLI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PLUGIN_ROOT, makeWorkspace, CONFIG_PATH } from "./fake-env.mjs";

const { loadState, upsertJob, updateState } = await import(pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs")).href);
const COMPANION = path.join(PLUGIN_ROOT, "scripts", "copilot-companion.mjs");

function companion(cwd, args, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], { cwd, encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });
}

function hook(script, cwd, input, args = []) {
  return spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "scripts", script), ...args], {
    cwd,
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    timeout: 60_000,
    env: process.env,
  });
}

const REVIEW_JSON = JSON.stringify({
  verdict: "needs-attention",
  summary: "One real bug.",
  findings: [{ file: "a.js", line_start: 1, line_end: 2, severity: "high", title: "Off by one", body: "Loop skips the last item.", confidence: 0.9, recommendation: "Use <=." }],
});

describe("companion", () => {
  it("setup reports version, auth and the review gate", () => {
    const cwd = makeWorkspace();
    const res = companion(cwd, ["setup", "--json", "--enable-review-gate"]);
    assert.equal(res.status, 0, res.stderr);
    const status = JSON.parse(res.stdout);
    assert.equal(status.installed, true);
    assert.equal(status.version, "1.0.102");
    assert.equal(status.reviewGate, true);
    assert.equal(loadState(cwd).config.reviewGate, true);
  });

  it("review renders the structured verdict and records usage", () => {
    const cwd = makeWorkspace();
    fs.writeFileSync(path.join(cwd, "a.js"), "for (let i = 0; i < n - 1; i++) {}\n");
    const res = companion(cwd, ["review"], { FAKE_REPLY: REVIEW_JSON });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Review Verdict: NEEDS ATTENTION/);
    assert.match(res.stdout, /HIGH: Off by one/);
    const job = loadState(cwd).jobs.find((j) => j.type === "review");
    assert.equal(job.status, "completed");
    assert.equal(job.aiCredits, 0.25);
    assert.ok(job.sessionID);
  });

  it("task runs in the foreground and can be resumed", () => {
    const cwd = makeWorkspace();
    const first = companion(cwd, ["task", "FAKE: say fixed the bug"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /fixed the bug/);
    const session = loadState(cwd).jobs.find((j) => j.type === "task").sessionID;

    const candidate = JSON.parse(companion(cwd, ["task-resume-candidate", "--json"]).stdout);
    assert.equal(candidate.available, true);
    assert.equal(candidate.sessionID, session);

    const resumed = companion(cwd, ["task", "--resume-last", "FAKE: say continued"]);
    assert.match(resumed.stdout, /continued/);
    const tasks = loadState(cwd).jobs.filter((j) => j.type === "task");
    assert.equal(tasks.find((j) => j.resumedFrom === session)?.sessionID, session);
  });

  it("a failing task exits non-zero with the error", () => {
    const cwd = makeWorkspace();
    const res = companion(cwd, ["task", "FAKE: error quota exceeded"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /quota exceeded/);
    assert.equal(loadState(cwd).jobs.find((j) => j.type === "task").status, "failed");
  });

  it("background tasks run detached and can be cancelled", async () => {
    const cwd = makeWorkspace();
    const res = companion(cwd, ["task", "--background", "FAKE: sleep 30000"]);
    assert.equal(res.status, 0, res.stderr);
    const jobId = /background: (\S+)/.exec(res.stdout)[1];
    let job;
    for (let i = 0; i < 50; i += 1) {
      job = loadState(cwd).jobs.find((j) => j.id === jobId);
      if (job?.sessionID) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(job.sessionID, "the worker opened a session");
    const cancel = companion(cwd, ["cancel", jobId]);
    assert.match(cancel.stdout, /Cancelled job/);
    for (let i = 0; i < 50; i += 1) {
      job = loadState(cwd).jobs.find((j) => j.id === jobId);
      if (job.status === "cancelled" && !isAlive(job.pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(job.status, "cancelled");
    assert.equal(isAlive(job.pid), false, "the detached worker is gone");
  });

  it("result shows the last finished job; cost aggregates credits", () => {
    const cwd = makeWorkspace();
    companion(cwd, ["task", "FAKE: say first"]);
    companion(cwd, ["task", "FAKE: say second"]);
    const result = companion(cwd, ["result"]);
    assert.match(result.stdout, /Copilot Session/);
    assert.match(result.stdout, /second/);
    const cost = companion(cwd, ["cost", "--html", path.join(cwd, "usage.html")]);
    assert.match(cost.stdout, /0\.5000 AI credits · 2 premium request\(s\) across 2 job\(s\)/);
    assert.ok(fs.readFileSync(path.join(cwd, "usage.html"), "utf8").includes("Copilot Usage Report"));
  });

  it("status lists jobs of this Claude session", () => {
    const cwd = makeWorkspace();
    companion(cwd, ["task", "FAKE: say hi"]);
    assert.match(companion(cwd, ["status"]).stdout, /task-/);
  });

  it("model wizard lists the live catalog and edits the config safely", () => {
    const cwd = makeWorkspace();
    const before = fs.readFileSync(CONFIG_PATH, "utf8");
    try {
      const list = companion(cwd, ["model", "list"]);
      assert.equal(list.status, 0, list.stderr);
      assert.match(list.stdout, /tier 3 {2}fake-premium {2}15x/);
      const moved = companion(cwd, ["model", "tier", "fake-pro", "1"]);
      assert.match(moved.stdout, /tiers\.1\.models/);
      assert.deepEqual(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).tiers["1"].models, ["fake-pro", "fake-std"]);
      const bad = companion(cwd, ["model", "effort", "global", "turbo"]);
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /EFFORT_INVALID/);
    } finally {
      fs.writeFileSync(CONFIG_PATH, before);
    }
  });
});

describe("stop review gate", () => {
  function transcript(dir, text) {
    const file = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({ type: "user", message: { content: "do it" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
    ].join("\n"));
    return file;
  }

  it("allows the stop while the gate is disabled", () => {
    const cwd = makeWorkspace();
    const res = hook("stop-review-gate-hook.mjs", cwd, { transcript_path: transcript(cwd, "Edited a.js") });
    assert.match(res.stdout, /ALLOW: Review gate is disabled/);
  });

  it("blocks with Claude Code's decision JSON when the reviewer says BLOCK", () => {
    const cwd = makeWorkspace();
    updateState(cwd, (s) => {
      s.config = { reviewGate: true };
    });
    const res = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs")], {
      cwd,
      input: JSON.stringify({ transcript_path: transcript(cwd, "Edited a.js") }),
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, FAKE_REPLY: "BLOCK: the new branch is untested" },
    });
    assert.equal(res.status, 0);
    assert.deepEqual(JSON.parse(res.stdout), { decision: "block", reason: "Copilot review gate: BLOCK: the new branch is untested" });
  });

  it("does not review again once a stop hook already blocked", () => {
    const cwd = makeWorkspace();
    updateState(cwd, (s) => {
      s.config = { reviewGate: true };
    });
    const res = hook("stop-review-gate-hook.mjs", cwd, { stop_hook_active: true, transcript_path: transcript(cwd, "x") });
    assert.match(res.stdout, /ALLOW: Stop already continued once/);
  });
});

describe("session end hook", () => {
  it("settles running jobs whose worker is gone, and leaves live ones alone", () => {
    const cwd = makeWorkspace();
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
    try {
      upsertJob(cwd, { id: "delegate-dead", type: "delegate", status: "running", workerPid: 2 ** 22 + 12345 });
      upsertJob(cwd, { id: "task-live", type: "task", status: "running", pid: sleeper.pid });
      const res = hook("session-lifecycle-hook.mjs", cwd, "{}", ["SessionEnd"]);
      assert.equal(res.status, 0);
      const jobs = loadState(cwd).jobs;
      assert.equal(jobs.find((j) => j.id === "delegate-dead").status, "failed");
      assert.equal(jobs.find((j) => j.id === "task-live").status, "running");
    } finally {
      sleeper.kill();
    }
  });
});

function isAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
