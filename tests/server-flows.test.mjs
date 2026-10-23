// End-to-end flows of the MCP server against the fake Copilot CLI: every
// tool goes through handleRpcMessage exactly as Claude Code would call it,
// and every worker is a real `--acp --stdio` child process.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_ROOT, makeWorkspace, agentStarts, writeConfig, TEST_CONFIG, COPILOT_HOME } from "./fake-env.mjs";

const server = await import(pathToFileURL(path.join(PLUGIN_ROOT, "mcp", "server.mjs")).href);
const { upsertJob, loadState } = await import(pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs")).href);

let nextId = 1;
async function call(name, args = {}) {
  const res = await server.handleRpcMessage({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });
  const payload = JSON.parse(res.result.content[0].text);
  if (res.result.isError) throw Object.assign(new Error(payload.error), { code: payload.code });
  return payload;
}

/** Chain wait calls until the session leaves `timeout`. */
async function waitDone(sessionID, cwd) {
  for (let i = 0; i < 20; i += 1) {
    const r = await call("wait", { sessionID, cwd });
    if (r.status !== "timeout") return r;
  }
  throw new Error("session never settled");
}

after(async () => {
  await call("shutdown", { cwd: makeWorkspace("teardown"), all: true }).catch(() => {});
});

describe("models", () => {
  it("merges config tiers with the live catalog of the account", async () => {
    const cwd = makeWorkspace();
    const res = await call("models", { cwd });
    assert.equal(res.live, true);
    const ids = res.models.map((m) => m.id);
    assert.deepEqual(ids.slice(0, 2), ["fake-cheap", "fake-std"]);
    assert.ok(!ids.includes("auto"), "the auto pseudo-model is not selectable");
    assert.ok(res.excluded.some((e) => e.id === "fake-disabled"), "models not enabled for the account are excluded");
    const premium = res.models.find((m) => m.id === "fake-premium");
    assert.equal(premium.tier, 3);
    assert.equal(premium.multiplier, 15);
    assert.match(res.hint, /tier 0 \(cheap\): fake-cheap 0\.33x/);
  });

  it("leaves no session behind for the catalog probe", async () => {
    const cwd = makeWorkspace();
    const before = fs.readdirSync(path.join(COPILOT_HOME, "session-state")).length;
    await call("models", { cwd, refresh: true });
    const after = fs.readdirSync(path.join(COPILOT_HOME, "session-state")).length;
    assert.equal(after, before);
  });
});

describe("delegate → wait", () => {
  it("runs a job to completion with its report, response and credits", async () => {
    const cwd = makeWorkspace();
    const started = await call("delegate", { cwd, task: "FAKE: plan\nFAKE: say working on it\nFAKE: report COMPLETED\nFAKE: say all done" });
    assert.equal(started.model, "fake-std");
    assert.equal(started.tier, 1);
    assert.equal(started.effort, "high");
    assert.match(started.reportPath, /\.cp-reports[\\/]delegate-.+\.md$/);

    const argv = agentStarts().at(-1).argv;
    assert.ok(argv.includes("--acp") && argv.includes("--stdio") && argv.includes("--no-ask-user"));
    assert.ok(argv.includes("--allow-tool=write"));
    assert.ok(argv.includes("--deny-tool=shell(git push)"));
    assert.deepEqual(argv.slice(argv.indexOf("--reasoning-effort"), argv.indexOf("--reasoning-effort") + 2), ["--reasoning-effort", "high"]);

    const done = await waitDone(started.sessionID, cwd);
    assert.equal(done.status, "idle");
    assert.equal(done.outcome, "completed");
    assert.match(done.response, /all done/);
    assert.equal(done.report.status, "STATUS: COMPLETED");
    assert.ok(done.report.content.includes("goal: fake"));
    assert.equal(done.aiCredits, 0.25);
    assert.equal(done.premiumRequests, 1);

    const again = await call("wait", { sessionID: started.sessionID, cwd });
    assert.equal(again.report.deliveredBefore, true, "the report body is delivered once");

    const job = loadState(cwd).jobs.find((j) => j.id === started.jobId);
    assert.equal(job.status, "completed");
    assert.equal(job.workerPid, null);
  });

  it("surfaces a permission ask as needsInput and resumes after respond", async () => {
    const cwd = makeWorkspace();
    const started = await call("delegate", { cwd, task: "FAKE: exec ls -la\nFAKE: exec npm run weird\nFAKE: report COMPLETED\nFAKE: say finished" });
    const asked = await waitDone(started.sessionID, cwd);
    assert.equal(asked.status, "needsInput");
    assert.equal(asked.permissions.length, 1, "ls was auto-approved by rule; only the unknown command asks");
    assert.equal(asked.permissions[0].command, "npm run weird");

    const answered = await call("respond", { sessionID: started.sessionID, permissionID: asked.permissions[0].id, response: "once" });
    assert.equal(answered.responded, true);
    const done = await waitDone(started.sessionID, cwd);
    assert.equal(done.outcome, "completed");

    const logs = await call("logs", { cwd, jobId: started.jobId });
    const text = logs.lines.join("\n");
    assert.match(text, /\[permission\] AUTO-APPROVE ls -la/);
    assert.match(text, /\[permission\] ONCE npm run weird/);
    assert.match(text, /\[tool\]/);
  });

  it("flags a completed run that skipped the mandatory report", async () => {
    const cwd = makeWorkspace();
    const started = await call("delegate", { cwd, task: "FAKE: say done, but no report" });
    const done = await waitDone(started.sessionID, cwd);
    assert.equal(done.outcome, "completed");
    assert.equal(done.reportMissing, true);
    assert.match(done.warning, /without writing its report/);
  });

  it("keeps a denied command from running while the turn carries on", async () => {
    const cwd = makeWorkspace();
    const started = await call("delegate", { cwd, task: "FAKE: exec git push origin main\nFAKE: report COMPLETED\nFAKE: say pushed nothing" });
    const done = await waitDone(started.sessionID, cwd);
    assert.equal(done.outcome, "completed");
    assert.ok(done.tools.some((t) => /git push/.test(t) && /failed/.test(t)), JSON.stringify(done.tools));
  });

  it("lets a reviewer write its report and nothing else", async () => {
    const cwd = makeWorkspace();
    const started = await call("delegate", { cwd, persona: "reviewer", task: "FAKE: report COMPLETED\nFAKE: say reviewed" });
    const argv = agentStarts().at(-1).argv;
    assert.ok(!argv.includes("--allow-tool=write"), "reviewers get no blanket write grant");
    const done = await waitDone(started.sessionID, cwd);
    assert.equal(done.outcome, "completed");
    assert.equal(done.report.status, "STATUS: COMPLETED");
  });

  it("honours an explicit model, tier and effort", async () => {
    const cwd = makeWorkspace();
    const cheap = await call("delegate", { cwd, tier: 0, task: "FAKE: report COMPLETED" });
    assert.equal(cheap.model, "fake-cheap");
    assert.equal(cheap.effort, "low", "per-tier effort policy");
    const pro = await call("delegate", { cwd, model: "fake-pro", effort: "max", task: "FAKE: report COMPLETED" });
    assert.equal(pro.model, "fake-pro");
    assert.equal(pro.effort, "max");
    await waitDone(cheap.sessionID, cwd);
    await waitDone(pro.sessionID, cwd);
  });

  it("rejects bad selections before starting any worker", async () => {
    const cwd = makeWorkspace();
    const starts = agentStarts().length;
    await assert.rejects(call("delegate", { cwd, model: "fake-disabled", task: "x" }), (err) => err.code === "MODEL_INVALID");
    await assert.rejects(call("delegate", { cwd, effort: "turbo", task: "x" }), (err) => err.code === "EFFORT_INVALID");
    await assert.rejects(call("delegate", { cwd, persona: "boss", task: "x" }), (err) => err.code === "PERSONA_INVALID");
    await assert.rejects(call("delegate", { cwd, task: "" }), (err) => err.code === "TASK_REQUIRED");
    assert.equal(agentStarts().length, starts);
  });
});

describe("failures, retries and nudges", () => {
  it("auto-retries a rate-limit failure one tier up, until the chain budget is spent", async () => {
    const cwd = makeWorkspace();
    const started = await call("delegate", { cwd, autoRetry: true, task: "FAKE: error rate limit exceeded" });
    const first = await waitDone(started.sessionID, cwd);
    assert.equal(first.status, "retried");
    assert.equal(first.model, "fake-pro");
    const second = await waitDone(first.newSessionID, cwd);
    assert.equal(second.status, "retried");
    assert.equal(second.model, "fake-premium");
    const last = await waitDone(second.newSessionID, cwd);
    assert.equal(last.status, "idle");
    assert.equal(last.outcome, "failed");
    assert.equal(last.escalation.kind, "rate");
    const jobs = loadState(cwd).jobs;
    assert.equal(jobs.filter((j) => j.retryOf).length, 2);
  });

  it("nudges an empty builder turn once and accepts the nudged result", async () => {
    process.env.FAKE_NUDGE = "report";
    try {
      const cwd = makeWorkspace();
      const started = await call("delegate", { cwd, task: "FAKE: empty" });
      const done = await waitDone(started.sessionID, cwd);
      assert.equal(done.outcome, "completed");
      assert.match(done.response, /done after nudge/);
      assert.equal(loadState(cwd).jobs.find((j) => j.id === started.jobId).nudgedCount, 1);
    } finally {
      delete process.env.FAKE_NUDGE;
    }
  });

  it("fails an empty builder run once the nudge is spent", async () => {
    const cwd = makeWorkspace();
    const started = await call("delegate", { cwd, task: "FAKE: empty" });
    const done = await waitDone(started.sessionID, cwd);
    assert.equal(done.outcome, "failed");
    assert.equal(done.error.name, "EmptyOutput");
    assert.equal(done.escalation.retryable, true);
  });

  it("reports a worker that dies mid-turn as a retryable failure", async () => {
    const cwd = makeWorkspace();
    const started = await call("delegate", { cwd, task: "FAKE: say starting\nFAKE: crash" });
    const done = await waitDone(started.sessionID, cwd);
    assert.equal(done.outcome, "failed");
    assert.equal(done.escalation.kind, "worker");
    assert.equal(done.escalation.retryable, true);
  });

  it("marks a job whose worker vanished with its server as WorkerLost", async () => {
    const cwd = makeWorkspace();
    upsertJob(cwd, { id: "delegate-ghost", type: "delegate", status: "running", sessionID: "0000-ghost-session", directory: cwd });
    const res = await call("wait", { sessionID: "0000-ghost-session", cwd });
    assert.equal(res.outcome, "failed");
    assert.equal(res.error.name, "WorkerLost");
    assert.match(res.nextStep, /resumeSessionID/);
    assert.equal(loadState(cwd).jobs.find((j) => j.id === "delegate-ghost").status, "failed");
  });
});

describe("resume, abort, status, diff", () => {
  it("continues an existing Copilot session with resumeSessionID", async () => {
    const cwd = makeWorkspace();
    const first = await call("delegate", { cwd, task: "FAKE: report COMPLETED" });
    await waitDone(first.sessionID, cwd);
    const resumed = await call("delegate", { cwd, resumeSessionID: first.sessionID, task: "FAKE: report COMPLETED\nFAKE: say continued" });
    assert.equal(resumed.sessionID, first.sessionID);
    assert.equal(resumed.resumedFrom, first.sessionID);
    const done = await waitDone(resumed.sessionID, cwd);
    assert.match(done.response, /continued/);
    assert.equal(done.aiCredits, 0.25, "credits are counted per job, not per session");
  });

  it("fails fast when the session to resume does not exist", async () => {
    const cwd = makeWorkspace();
    await assert.rejects(call("delegate", { cwd, resumeSessionID: "aaaa-bbbb-missing", task: "x" }), (err) => err.code === "RESUME_SESSION_NOT_FOUND");
  });

  it("aborts a running job and reports it cancelled", async () => {
    const cwd = makeWorkspace();
    const started = await call("delegate", { cwd, task: "FAKE: say slow job\nFAKE: sleep 20000" });
    const snap = await call("status", { cwd, sessionID: started.sessionID });
    assert.equal(snap.live, true);
    assert.equal(snap.state, "busy");
    const aborted = await call("abort", { cwd, sessionID: started.sessionID });
    assert.equal(aborted.aborted, true);
    const done = await call("wait", { cwd, sessionID: started.sessionID });
    assert.equal(done.outcome, "cancelled");
    assert.equal(loadState(cwd).jobs.find((j) => j.id === started.jobId).status, "cancelled");
  });

  it("lists recent jobs and shows the worker's blast radius", async () => {
    const cwd = makeWorkspace();
    const started = await call("delegate", { cwd, task: "FAKE: report COMPLETED" });
    await waitDone(started.sessionID, cwd);
    const list = await call("status", { cwd });
    assert.ok(list.jobs.some((j) => j.id === started.jobId && j.status === "completed"));
    const diff = await call("diff", { cwd, sessionID: started.sessionID });
    assert.equal(diff.jobId, started.jobId);
    assert.ok(JSON.stringify(diff).includes(".cp-reports"), JSON.stringify(diff));
  });
});

describe("fanOut", () => {
  it("starts a batch and supervises it with waitAll", async () => {
    const cwd = makeWorkspace();
    const batch = await call("fanOut", { cwd, tasks: ["FAKE: report COMPLETED\nFAKE: say one", "FAKE: report COMPLETED\nFAKE: say two"] });
    assert.equal(batch.started, 2);
    const ids = batch.jobs.map((j) => j.sessionID);
    let res;
    for (let i = 0; i < 10; i += 1) {
      res = await call("waitAll", { cwd, sessionIDs: ids });
      if (res.summary.timeout === 0) break;
    }
    assert.equal(res.summary.idle, 2);
    assert.deepEqual(res.results.map((r) => r.outcome), ["completed", "completed"]);
  });

  it("race mode keeps the first clean finisher and aborts the rest", async () => {
    const cwd = makeWorkspace();
    const res = await call("fanOut", { cwd, mode: "race", timeoutSec: 60, tasks: ["FAKE: report COMPLETED\nFAKE: say fast", "FAKE: sleep 30000"] });
    assert.equal(res.winner.index, 0);
    assert.match(res.winner.response, /fast/);
    assert.deepEqual(res.aborted.map((a) => a.index), [1]);
  });
});

describe("guards", () => {
  it("refuses new work once today's credits reach the budget", async () => {
    const cwd = makeWorkspace();
    const first = await call("delegate", { cwd, task: "FAKE: report COMPLETED" });
    await waitDone(first.sessionID, cwd);
    writeConfig({ budget: { maxDailyCredits: 0.2 } });
    try {
      await assert.rejects(call("delegate", { cwd, task: "x" }), (err) => err.code === "BUDGET_DAILY_CREDITS");
    } finally {
      writeConfig();
    }
  });

  it("caps concurrent workers", async () => {
    writeConfig({ concurrency: { maxDelegates: 1 } });
    const cwd = makeWorkspace();
    try {
      const running = await call("delegate", { cwd, task: "FAKE: sleep 20000" });
      await assert.rejects(call("delegate", { cwd, task: "x" }), (err) => err.code === "DELEGATE_LIMIT_EXCEEDED");
      const stopped = await call("shutdown", { cwd });
      assert.deepEqual(stopped.stopped.map((s) => s.sessionID), [running.sessionID]);
      assert.equal(loadState(cwd).jobs.find((j) => j.id === running.jobId).status, "cancelled");
    } finally {
      writeConfig(TEST_CONFIG);
    }
  });
});
