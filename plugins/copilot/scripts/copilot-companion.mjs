#!/usr/bin/env node

// Copilot Companion - entry point behind the plugin's slash commands.
// Mirrors the codex-plugin-cc companion architecture; every Copilot turn runs
// through a short-lived `copilot --acp` worker (scripts/lib/copilot-run.mjs).

import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { parseArgs, extractTaskText } from "./lib/args.mjs";
import { spawnDetached } from "./lib/process.mjs";
import { getCopilotVersion, detectAuth, discardEmptySession } from "./lib/copilot-bin.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, updateState, upsertJob, jobDataPath } from "./lib/state.mjs";
import { buildStatusSnapshot, resolveResultJob, resolveCancelableJob, enrichJob, buildCostSnapshot } from "./lib/job-control.mjs";
import { createJobRecord, runTrackedJob, getHostSessionId } from "./lib/tracked-jobs.mjs";
import { renderStatus, renderResult, renderReview, renderSetup, renderCost, renderCostHtml } from "./lib/render.mjs";
import { buildReviewPrompt, buildTaskPrompt } from "./lib/prompts.mjs";
import { readJson, writeJson } from "./lib/fs.mjs";
import { isProcessAlive, getProcessCommand, stopProcessTree } from "./lib/process-identity.mjs";
import { runCopilotPrompt, pickModel } from "./lib/copilot-run.mjs";
import { configPath, loadConfig, buildCatalog, readCachedCatalog, rememberLiveCatalog, formatHint, EFFORT_LEVELS } from "../mcp/lib/catalog.mjs";
import { validateModelConfig, setModelTier, setDefaultModel, setExcluded, setEffort, describeChanges } from "../mcp/lib/model-config.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------

async function handleSetup(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json", "enable-review-gate", "disable-review-gate"] });
  const version = await getCopilotVersion();
  const workspace = await resolveWorkspace();

  let reviewGate;
  if (options["enable-review-gate"] || options["disable-review-gate"]) {
    reviewGate = Boolean(options["enable-review-gate"]);
    updateState(workspace, (state) => {
      state.config = state.config || {};
      state.config.reviewGate = reviewGate;
    });
  } else {
    reviewGate = loadState(workspace).config?.reviewGate ?? false;
  }

  const picked = version ? pickModel({}) : { model: null };
  const status = {
    installed: Boolean(version),
    version,
    auth: version ? detectAuth() : null,
    defaultModel: picked.model,
    reviewGate,
  };
  console.log(options.json ? JSON.stringify(status, null, 2) : renderSetup(status));
}

// ------------------------------------------------------------------
// Review
// ------------------------------------------------------------------

async function handleReview(argv) {
  await runReview(argv, { adversarial: false });
}

async function handleAdversarialReview(argv) {
  await runReview(argv, { adversarial: true });
}

async function runReview(argv, { adversarial }) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["base", "scope", "model", "effort"],
    booleanOptions: ["wait", "background"],
  });
  const focus = adversarial ? positional.join(" ").trim() : "";
  const workspace = await resolveWorkspace();
  const type = adversarial ? "adversarial-review" : "review";
  const { model, effort } = pickModel({ model: options.model, effort: options.effort });
  const job = createJobRecord(workspace, type, { base: options.base ?? null, ...(focus ? { focus } : {}), model });

  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Starting Copilot worker...");
      const prompt = await buildReviewPrompt(workspace, { base: options.base, adversarial, focus }, PLUGIN_ROOT);
      log(`Prompt length: ${prompt.length} chars${focus ? `, focus: ${focus}` : ""}`);
      report("reviewing", adversarial ? "Running adversarial review..." : "Running review...");
      const run = await runCopilotPrompt({
        cwd: workspace,
        prompt,
        model,
        effort,
        write: false,
        onSession: (s) => upsertJob(workspace, { id: job.id, sessionID: s.id, model: s.model }),
      });
      recordUsage(workspace, job.id, run);
      if (run.error) throw new Error(run.error.message);
      report("finalizing", "Processing review output...");
      const structured = tryParseJson(run.text);
      return { rendered: structured ? renderReview(structured) : run.text, structured, response: run.text, sessionID: run.sessionId };
    });
    console.log(result.rendered);
  } catch (err) {
    console.error(`${adversarial ? "Adversarial review" : "Review"} failed: ${err.message}`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------
// Task (rescue delegation)
// ------------------------------------------------------------------

const TASK_VALUE_FLAGS = ["model", "effort"];
const TASK_BOOL_FLAGS = ["write", "read-only", "background", "wait", "resume-last", "fresh"];

async function handleTask(argv) {
  const { options } = parseArgs(argv, { valueOptions: TASK_VALUE_FLAGS, booleanOptions: TASK_BOOL_FLAGS });
  const taskText = extractTaskText(argv, TASK_VALUE_FLAGS, TASK_BOOL_FLAGS);
  if (!taskText) {
    console.error("No task text provided.");
    process.exit(1);
  }
  if (options.effort && !EFFORT_LEVELS.includes(options.effort)) {
    console.error(`--effort must be one of ${EFFORT_LEVELS.join("|")}`);
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const write = options["read-only"] ? false : true;
  const resumeSessionId = options["resume-last"] ? lastTaskSession(workspace)?.sessionID ?? null : null;
  const { model, effort } = pickModel({ model: options.model, effort: options.effort });
  const job = createJobRecord(workspace, "task", { write, model, effort, resumedFrom: resumeSessionId, task: taskText.slice(0, 500) });

  if (options.background) {
    const workerArgs = [
      path.join(PLUGIN_ROOT, "scripts", "copilot-companion.mjs"),
      "task-worker",
      "--job-id", job.id,
      "--workspace", workspace,
      "--task-text", taskText,
    ];
    if (write) workerArgs.push("--write");
    if (resumeSessionId) workerArgs.push("--resume-session", resumeSessionId);
    if (model) workerArgs.push("--model", model);
    if (effort) workerArgs.push("--effort", effort);
    const child = spawnDetached(process.execPath, workerArgs, { cwd: workspace });
    upsertJob(workspace, { id: job.id, status: "running", pid: child.pid ?? null });
    console.log(`Copilot task started in background: ${job.id}`);
    console.log("Check `/copilot:status` for progress.");
    return;
  }

  try {
    const result = await runTask(workspace, job, { taskText, write, model, effort, resumeSessionId });
    console.log(result.rendered);
  } catch (err) {
    console.error(`Task failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["job-id", "workspace", "task-text", "model", "effort", "resume-session"],
    booleanOptions: ["write"],
  });
  const workspace = options.workspace;
  const jobId = options["job-id"];
  const taskText = options["task-text"];
  if (!workspace || !jobId || !taskText) process.exit(1);

  // /copilot:cancel signals this process; cancel the Copilot turn so the
  // session is left resumable, then record the cancellation.
  const controller = new AbortController();
  let cancelled = false;
  process.on("SIGTERM", () => {
    cancelled = true;
    controller.abort();
  });

  try {
    await runTask(workspace, { id: jobId }, {
      taskText,
      write: Boolean(options.write),
      model: options.model ?? null,
      effort: options.effort ?? null,
      resumeSessionId: options["resume-session"] ?? null,
      signal: controller.signal,
    });
  } catch {
    // runTrackedJob already recorded the failure
  }
  if (cancelled) {
    upsertJob(workspace, { id: jobId, status: "cancelled", completedAt: new Date().toISOString(), errorMessage: "Cancelled by user" });
  }
  process.exit(0);
}

async function runTask(workspace, job, opts) {
  return runTrackedJob(workspace, job, async ({ report, log }) => {
    report("starting", opts.resumeSessionId ? `Resuming Copilot session ${opts.resumeSessionId}...` : "Starting Copilot worker...");
    const prompt = buildTaskPrompt(opts.taskText, { write: opts.write });
    log(`Model: ${opts.model ?? "(Copilot default)"}, effort: ${opts.effort ?? "(default)"}, write: ${opts.write}, prompt: ${prompt.length} chars`);
    report("investigating", "Running task...");
    const run = await runCopilotPrompt({
      cwd: workspace,
      prompt,
      model: opts.model,
      effort: opts.effort,
      write: opts.write,
      resumeSessionId: opts.resumeSessionId,
      signal: opts.signal,
      onSession: (s) => upsertJob(workspace, { id: job.id, sessionID: s.id, model: s.model, workerPid: s.pid ?? null }),
      onActivity: (kind, text) => {
        if (kind === "tool" || kind === "permission") log(`[${kind}] ${text}`);
      },
    });
    recordUsage(workspace, job.id, run);
    if (run.error) throw new Error(run.error.message);
    if (run.stopReason === "cancelled") throw new Error("Cancelled by user");
    report("finalizing", "Done");
    return { rendered: run.text || "(Copilot returned no text)", response: run.text, summary: run.text.slice(0, 500), sessionID: run.sessionId };
  });
}

function recordUsage(workspace, jobId, run) {
  upsertJob(workspace, {
    id: jobId,
    sessionID: run.sessionId,
    model: run.model,
    workerPid: null,
    ...(run.accounting ?? {}),
    ...(run.usage ? { tokens: { input: run.usage.inputTokens ?? null, output: run.usage.outputTokens ?? null } } : {}),
  });
}

function lastTaskSession(workspace, { includeRunning = false } = {}) {
  const sessionId = getHostSessionId();
  return (loadState(workspace).jobs ?? [])
    .filter((j) => j.type === "task" && j.sessionID)
    .filter((j) => j.status === "completed" || (includeRunning && j.status === "running"))
    .filter((j) => !sessionId || j.sessionId === sessionId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0] ?? null;
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });
  const workspace = await resolveWorkspace();
  const lastTask = lastTaskSession(workspace, { includeRunning: true });
  const result = { available: Boolean(lastTask), jobId: lastTask?.id ?? null, sessionID: lastTask?.sessionID ?? null };
  console.log(options.json ? JSON.stringify(result) : result.available ? `Resumable session: ${result.sessionID}` : "No resumable session.");
}

// ------------------------------------------------------------------
// Status / Result / Cancel / Cost
// ------------------------------------------------------------------

async function handleStatus() {
  const workspace = await resolveWorkspace();
  const snapshot = buildStatusSnapshot(loadState(workspace).jobs ?? [], workspace, { sessionId: getHostSessionId() });
  console.log(renderStatus(snapshot));
}

async function handleCost(argv) {
  const workspace = await resolveWorkspace();
  let config = null;
  try {
    config = loadConfig();
  } catch {
    // budget limits simply render as unset
  }
  const snapshot = buildCostSnapshot(loadState(workspace).jobs ?? [], config);
  const htmlIdx = argv.indexOf("--html");
  if (htmlIdx !== -1) {
    const outArg = argv[htmlIdx + 1];
    const outPath = outArg && !outArg.startsWith("-") ? path.resolve(outArg) : path.join(workspace, "copilot-usage.html");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, renderCostHtml(snapshot));
    console.log(`Usage dashboard written: ${outPath}`);
  }
  console.log(renderCost(snapshot));
}

async function handleResult(argv) {
  const { positional } = parseArgs(argv, {});
  const workspace = await resolveWorkspace();
  const { job, ambiguous } = resolveResultJob(loadState(workspace).jobs ?? [], positional[0]);
  if (ambiguous) {
    console.error("Ambiguous job reference. Please provide a more specific ID prefix.");
    process.exit(1);
  }
  if (!job) {
    console.log("No finished job found.");
    return;
  }
  console.log(renderResult(enrichJob(job, workspace), readJson(jobDataPath(workspace, job.id))));
}

async function handleCancel(argv) {
  const { positional } = parseArgs(argv, {});
  const workspace = await resolveWorkspace();
  const { job, ambiguous } = resolveCancelableJob(loadState(workspace).jobs ?? [], positional[0]);
  if (ambiguous) {
    console.error("Multiple running jobs. Please specify a job ID prefix.");
    process.exit(1);
  }
  if (!job) {
    console.log("No active job to cancel.");
    return;
  }

  upsertJob(workspace, { id: job.id, status: "cancelled", completedAt: new Date().toISOString(), errorMessage: "Cancelled by user" });

  // Background companion tasks: signal the node worker, which cancels its
  // Copilot turn cleanly. MCP delegations: stop the copilot worker process
  // itself (identity-checked); the MCP server records the cancellation.
  const targets = [];
  if (Number.isInteger(job.pid) && job.pid !== process.pid) targets.push({ pid: job.pid, expect: /copilot-companion\.mjs/ });
  if (Number.isInteger(job.workerPid)) targets.push({ pid: job.workerPid, expect: /copilot/i });
  for (const { pid, expect } of targets) {
    if (!isProcessAlive(pid)) continue;
    if (!expect.test(getProcessCommand(pid))) continue; // recycled pid: never signal a stranger
    await stopProcessTree(pid, { graceMs: 5000 });
  }
  console.log(`Cancelled job: ${job.id}`);
}

// ------------------------------------------------------------------
// Model wizard backend (used by /copilot:model)
// ------------------------------------------------------------------

function readModelsConfig() {
  return JSON.parse(fs.readFileSync(configPath(), "utf8"));
}

/** Live catalog: the cache, or a short probe session when asked to refresh. */
async function liveModels(refresh) {
  let cached = refresh ? null : readCachedCatalog({ maxAgeMs: Infinity });
  if (!cached) {
    const { startCopilotSession } = await import("../mcp/lib/copilot-session.mjs");
    const workspace = await resolveWorkspace();
    const probe = await startCopilotSession({ cwd: workspace });
    try {
      rememberLiveCatalog(probe.models);
    } finally {
      await probe.close({ graceMs: 1000 }).catch(() => {});
      discardEmptySession(probe.id);
    }
    cached = readCachedCatalog({ maxAgeMs: Infinity });
  }
  return cached;
}

async function handleModel(argv) {
  const op = argv[0];
  if (!op || op === "help") {
    console.log(
      [
        "Usage:",
        "  model list [--refresh]            live catalog with tiers and multipliers",
        "  model tier <id> <0-3>             put a model first in a tier",
        "  model default <id>|--clear        default model for delegations",
        "  model exclude <id> [reason]       never select this model",
        "  model include <id>                undo an exclusion",
        "  model effort global|tier:N|model:<id> low|medium|high|xhigh|max|off",
        "  model check                       validate config/models.json",
      ].join("\n")
    );
    return;
  }
  const { options, positional } = parseArgs(argv.slice(1), { booleanOptions: ["refresh", "clear"] });

  if (op === "check") {
    const problems = validateModelConfig(readModelsConfig());
    if (problems.length === 0) console.log("config/models.json is valid.");
    else {
      for (const p of problems) console.error(`- ${p}`);
      process.exitCode = 1;
    }
    return;
  }

  if (op === "list") {
    const config = readModelsConfig();
    const cached = await liveModels(options.refresh === true);
    const catalog = buildCatalog(config, cached?.models ?? null);
    console.log(`Catalog ${catalog.live ? `from Copilot (fetched ${cached.fetchedAt})` : "from config only (not verified against your account)"}`);
    for (const m of catalog.models) {
      const flags = [m.default ? "default" : null, m.configured ? null : "auto-tiered"].filter(Boolean).join(",");
      console.log(`tier ${m.tier}  ${m.id}  ${m.multiplier != null ? `${m.multiplier}x` : "?x"}  ${m.priceCategory ?? ""}${flags ? `  (${flags})` : ""}`);
    }
    for (const e of catalog.excluded) console.log(`excluded  ${e.id}${e.reason ? `  — ${e.reason}` : ""}`);
    console.log(`\n${formatHint(config, catalog.models)}`);
    return;
  }

  const before = readModelsConfig();
  let res;
  if (op === "tier") res = setModelTier(before, { id: positional[0], tier: positional[1] });
  else if (op === "default") res = setDefaultModel(before, { id: options.clear ? null : positional[0] ?? null });
  else if (op === "exclude") res = setExcluded(before, { id: positional[0], exclude: true, reason: positional.slice(1).join(" ") });
  else if (op === "include") res = setExcluded(before, { id: positional[0], exclude: false });
  else if (op === "effort") {
    const scopeArg = positional[0] ?? "";
    let scope = null;
    if (scopeArg === "global") scope = { kind: "global" };
    else if (scopeArg.startsWith("tier:")) scope = { kind: "tier", tier: Number(scopeArg.slice(5)) };
    else if (scopeArg.startsWith("model:")) scope = { kind: "model", id: scopeArg.slice(6) };
    res = setEffort(before, { scope, level: positional[1] ?? "" });
  } else {
    console.error(`Unknown model operation: ${op} (use list/tier/default/exclude/include/effort/check/help)`);
    process.exitCode = 1;
    return;
  }

  if (!res.ok) {
    console.error(`ERROR ${res.code}: ${res.reason}`);
    process.exitCode = 1;
    return;
  }
  const problems = validateModelConfig(res.config);
  if (problems.length > 0) {
    console.error("ERROR: operation would produce an invalid config:");
    for (const p of problems) console.error(`- ${p}`);
    console.error("Nothing written.");
    process.exitCode = 1;
    return;
  }
  writeJson(configPath(), res.config);
  console.log("OK. Changes:");
  for (const line of describeChanges(before, res.config)) console.log(`  ${line}`);
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Parse the review JSON out of a model answer (bare, or inside a code fence).
 * @param {string} text
 * @returns {object|null}
 */
function tryParseJson(text) {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const candidates = [fenced?.[1], text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

// ------------------------------------------------------------------
// Subcommand dispatch (last, so every handler and constant above is initialized)
// ------------------------------------------------------------------

const [subcommand, ...argv] = process.argv.slice(2);

const handlers = {
  setup: handleSetup,
  review: handleReview,
  "adversarial-review": handleAdversarialReview,
  task: handleTask,
  "task-worker": handleTaskWorker,
  "task-resume-candidate": handleTaskResumeCandidate,
  status: handleStatus,
  cost: handleCost,
  model: handleModel,
  result: handleResult,
  cancel: handleCancel,
};

const handler = handlers[subcommand];
if (!handler) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error(`Available: ${Object.keys(handlers).join(", ")}`);
  process.exit(1);
}

handler(argv).catch((err) => {
  console.error(`Error in ${subcommand}: ${err.message}`);
  process.exit(1);
});
