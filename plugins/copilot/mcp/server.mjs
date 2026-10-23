// Copilot delegation MCP server.
// JSON-RPC 2.0 over stdio, one message per line, zero npm dependencies.
// Methods: initialize, tools/list, tools/call; anything else with an id → -32601.
//
// Twelve tools: models, delegate, fanOut, wait, waitAll, status, logs, diff,
// respond, abort, shutdown, doctor. Reachable from Claude Code as
// mcp__plugin_copilot_cp__<tool> (plugin name "copilot", server key "cp").
//
// Each delegated job runs in its own `copilot --acp --stdio` worker owned by
// this process (see mcp/lib/copilot-session.mjs). Workers live as long as the
// MCP server does; their sessions persist in Copilot's own session store and
// can be continued later with delegate.resumeSessionID.

import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { startCopilotSession } from "./lib/copilot-session.mjs";
import {
  loadConfig,
  buildCatalog,
  readCachedCatalog,
  rememberLiveCatalog,
  resolveSelection,
  formatHint,
  EFFORT_LEVELS,
} from "./lib/catalog.mjs";
import {
  PERSONA_NAMES,
  REPORTS_DIR,
  buildWorkerPrompt,
  nudgePrompt,
  reportPathFor,
  workerToolPolicy,
} from "./lib/worker-prompt.mjs";
import { snapshotGitHead, diffSinceSnapshot } from "./lib/workspace-diff.mjs";
import { SKILL_NAMES, DEFAULT_BUILDER_SKILLS, DEFAULT_REVIEWER_SKILLS, resolveSkillNames, renderSkillDigest } from "./lib/skills.mjs";
import { buildEscalation } from "./lib/escalation.mjs";
import { checkBudget, summarizeBudget } from "./lib/budget.mjs";
import { createActivitySink } from "./lib/activity-log.mjs";
import { emitLog, setLogSink, setLogLevel } from "./lib/mcp-log.mjs";
import { runDiagnostics, formatDoctorReport } from "../scripts/lib/doctor.mjs";
import { createJobRecord } from "../scripts/lib/tracked-jobs.mjs";
import { loadState, upsertJob, stateBase, generateJobId, jobDataPath, jobLogPath } from "../scripts/lib/state.mjs";
import { readJson, writeJson, tailLines } from "../scripts/lib/fs.mjs";
import { sweepStateDirs } from "../scripts/lib/hygiene.mjs";
import { getGitRoot } from "../scripts/lib/git.mjs";
import { readSessionAccounting, discardEmptySession, copilotHome } from "../scripts/lib/copilot-bin.mjs";
import { isProcessAlive, getProcessCommand, stopProcessTree } from "../scripts/lib/process-identity.mjs";

/**
 * Default workspace for tools called without an explicit cwd: the git root of
 * the directory Claude Code launched the server from (else that directory).
 * Exported for tests.
 */
export const DEFAULT_CWD = (await getGitRoot(process.cwd())) ?? process.cwd();

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_WAIT_TIMEOUT_SEC = 600;
// Without a progressToken a wait returns one activity snapshot per slice so
// the supervisor sees live movement (override with CP_WAIT_SLICE_SEC).
const WAIT_SLICE_SEC = 60;
// MCP progress frames render in Claude Code's UI only — they never enter the
// model context, so streaming them costs nothing.
const PROGRESS_INTERVAL_MS_DEFAULT = 8_000;
const POLL_MS = 5_000;
const MAX_NUDGES = 1;
const RESPONSE_MAX_CHARS = 8_000;
const REPORT_MAX_CHARS = 8_000;
const MAX_FINISHED_ENTRIES = 100;

let progressNotifier = null;

/**
 * Register the stdout writer used for notifications/progress frames.
 * @param {(msg: object) => void} [fn]
 */
export function setProgressNotifier(fn) {
  progressNotifier = typeof fn === "function" ? fn : null;
}

/**
 * Build a throttled progress emitter for one tool call.
 * @param {object|undefined} meta - request params._meta ({progressToken})
 * @param {{ totalSec?: number }} [opts]
 * @returns {((message: string) => boolean)|null}
 */
export function buildProgressEmitter(meta, opts = {}) {
  const token = meta?.progressToken;
  if (token === undefined || token === null || !progressNotifier) return null;
  const total = Number.isFinite(opts.totalSec) ? Math.max(1, Math.round(opts.totalSec)) : undefined;
  const envInterval = Number(process.env.CP_PROGRESS_INTERVAL_MS);
  const intervalMs = Number.isFinite(envInterval) && envInterval >= 250 ? envInterval : PROGRESS_INTERVAL_MS_DEFAULT;
  const startedAt = Date.now();
  let lastSent = 0;
  return (message) => {
    const now = Date.now();
    if (now - lastSent < intervalMs) return false;
    lastSent = now;
    const elapsedSec = Math.round((now - startedAt) / 1000);
    try {
      progressNotifier({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: token,
          ...(total !== undefined ? { total, progress: Math.min(total, elapsedSec) } : { progress: elapsedSec }),
          message: String(message).slice(0, 400),
        },
      });
      return true;
    } catch {
      return false; // a broken notifier must never kill a supervision loop
    }
  };
}

function shortId(id) {
  return typeof id === "string" ? id.slice(0, 8) : "?";
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Validate the workspace directory argument. The path is returned unchanged
 * (no realpath) so state keys stay stable for callers that always pass the
 * same spelling.
 * @param {object} args
 * @returns {string}
 */
function resolveCwd(args) {
  const cwd = args?.cwd ?? DEFAULT_CWD;
  if (typeof cwd !== "string" || !cwd.trim()) throw fail("CWD_INVALID", "cwd must be a non-empty string");
  if (!path.isAbsolute(cwd)) throw fail("CWD_NOT_ABSOLUTE", `cwd must be an absolute path: ${cwd}`);
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw fail("CWD_NOT_FOUND", `cwd does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) throw fail("CWD_NOT_DIRECTORY", `cwd is not a directory: ${cwd}`);
  return cwd;
}

/* ------------------------------ live workers ------------------------------ */

/**
 * Every worker this process started, keyed by Copilot session id. Finished
 * entries stay (worker closed) so wait/status/logs keep answering; the map is
 * pruned to the newest MAX_FINISHED_ENTRIES finished ones.
 * @type {Map<string, object>}
 */
const live = new Map();

// Shared activity sink: per-job log lines consumed by the logs tool and the
// one-line summaries in progress frames. Exported for tests.
export const activitySink = createActivitySink();

// Job ids whose report content was already embedded in a wait response. The
// first idle wait delivers the full report; later waits only confirm it was
// seen — this is what makes the hygiene reaper's deferred deletion safe.
const reportsDelivered = new Set();

/**
 * Read the report a delegated worker wrote for a job, capped to
 * REPORT_MAX_CHARS. Exported for tests.
 * @param {string} cwd
 * @param {string} jobId
 * @param {{ peek?: boolean }} [opts] - peek does not mark the report delivered
 * @returns {{ path: string, status: string|null, chars: number, truncated: boolean, content?: string, deliveredBefore?: boolean }|null}
 */
export function readReportSnapshot(cwd, jobId, { peek = false } = {}) {
  const file = reportPathFor(cwd, jobId);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const status = (raw.split("\n", 1)[0] ?? "").trim() || null;
  const base = { path: file, status, chars: raw.length, truncated: raw.length > REPORT_MAX_CHARS };
  if (peek) return { ...base, content: raw.slice(0, REPORT_MAX_CHARS) };
  const alreadyDelivered = reportsDelivered.has(jobId);
  if (reportsDelivered.size >= 500) reportsDelivered.clear();
  reportsDelivered.add(jobId);
  return alreadyDelivered ? { ...base, deliveredBefore: true } : { ...base, content: raw.slice(0, REPORT_MAX_CHARS) };
}

/**
 * Boot-time + periodic hygiene sweep wrapper. Fire-and-forget: stdout is
 * reserved for JSON-RPC, so results surface as MCP log notifications.
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function runHygieneSweep(opts = {}) {
  const res = sweepStateDirs(opts);
  const cleaned = res.removedDirs.length + res.removedJobFiles.length + res.removedTmpFiles.length + res.removedReports.length;
  if (cleaned > 0 || res.errors.length > 0 || opts.dryRun) {
    emitLog(
      res.errors.length > 0 ? "warning" : "info",
      `hygiene sweep: ${res.scanned} workspace dir(s), removed ${res.removedDirs.length} stale dir(s), ${res.removedJobFiles.length} orphan job file(s), ${res.removedTmpFiles.length} tmp leftover(s), ${res.removedReports.length} old report(s)`,
      { force: true, data: opts.dryRun ? { dryRun: true, ...res } : undefined }
    );
  }
  return res;
}

/* --------------------------------- catalog -------------------------------- */

/**
 * Selectable models: config tiers merged with the live catalog. The live list
 * comes from the on-disk cache; when it is missing or stale (or refresh is
 * asked for) a short-lived worker reads it and its empty session is removed.
 * @param {string} cwd
 * @param {{ refresh?: boolean }} [opts]
 */
async function getCatalog(cwd, { refresh = false } = {}) {
  const config = loadConfig();
  let cached = refresh ? null : readCachedCatalog();
  let liveError = null;
  if (!cached) {
    let probe = null;
    try {
      probe = await startCopilotSession({ cwd });
      rememberLiveCatalog(probe.models);
      cached = readCachedCatalog();
    } catch (err) {
      liveError = err.message;
      cached = readCachedCatalog({ maxAgeMs: Infinity }); // a stale list beats none
    } finally {
      if (probe) {
        await probe.close({ graceMs: 1000 }).catch(() => {});
        discardEmptySession(probe.id);
      }
    }
  }
  return {
    config,
    ...buildCatalog(config, cached?.models ?? null),
    fetchedAt: cached?.fetchedAt ?? null,
    ...(liveError ? { liveError } : {}),
  };
}

/** Catalog without any I/O beyond the cache (for escalation hints). */
function cachedCatalogModels(config) {
  return buildCatalog(config, readCachedCatalog({ maxAgeMs: Infinity })?.models ?? null).models;
}

async function toolModels(args) {
  const cwd = resolveCwd(args);
  const catalog = await getCatalog(cwd, { refresh: args.refresh === true });
  const { config } = catalog;
  return {
    models: catalog.models,
    excluded: catalog.excluded,
    live: catalog.live,
    fetchedAt: catalog.fetchedAt,
    ...(catalog.liveError ? { liveError: catalog.liveError } : {}),
    defaults: config.defaults ?? {},
    effortLevels: EFFORT_LEVELS,
    effortPolicy: config.effortPolicy ?? {},
    hint: formatHint(config, catalog.models),
    budget: summarizeBudget(config, loadState(cwd).jobs ?? []),
  };
}

/* -------------------------------- job helpers ----------------------------- */

/**
 * Find a delegate job for a sessionID, first in the given workspace, then
 * across every workspace state dir (fanOut tasks may live in per-task
 * workspaces while wait/waitAll are called with the primary cwd).
 * @returns {{ job: object|null, jobCwd: string }}
 */
export function findJobRecord(cwd, sessionID) {
  const direct = (loadState(cwd).jobs ?? []).find((j) => j.sessionID === sessionID);
  if (direct) return { job: direct, jobCwd: cwd };
  let hashes = [];
  try {
    hashes = fs.readdirSync(stateBase());
  } catch {
    return { job: null, jobCwd: cwd };
  }
  for (const h of hashes) {
    let jobs;
    try {
      jobs = JSON.parse(fs.readFileSync(path.join(stateBase(), h, "state.json"), "utf8")).jobs ?? [];
    } catch {
      continue;
    }
    const hit = jobs.find((j) => j.sessionID === sessionID && typeof j.directory === "string");
    if (hit) return { job: hit, jobCwd: hit.directory };
  }
  return { job: null, jobCwd: cwd };
}

function jobById(cwd, jobId) {
  return (loadState(cwd).jobs ?? []).find((j) => j.id === jobId) ?? null;
}

/** config.retryPolicy.maxAutoRetries, default 2. */
function maxAutoRetries(config) {
  const v = config?.retryPolicy?.maxAutoRetries;
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 2;
}

/** Length of the retryOf chain ending at this job (capped walk). */
function retryChainDepth(cwd, job) {
  let depth = 0;
  let current = job;
  const seen = new Set();
  const jobs = loadState(cwd).jobs ?? [];
  while (current?.retryOf && depth < 5 && !seen.has(current.id)) {
    seen.add(current.id);
    const prev = jobs.find((j) => j.id === current.retryOf);
    if (!prev) break;
    depth += 1;
    current = prev;
  }
  return depth;
}

function runningEntries() {
  return [...live.values()].filter((e) => !e.terminal);
}

function pruneFinished() {
  const finished = [...live.entries()].filter(([, e]) => e.terminal);
  for (const [sid] of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_ENTRIES))) live.delete(sid);
}

/**
 * Credits/premium requests a session consumed since `base` (cumulative
 * session accounting minus what it had already used before this job).
 */
function accountingDelta(sessionId, base) {
  const now = readSessionAccounting(sessionId);
  if (!now) return null;
  const round = (n) => Math.round(n * 1e6) / 1e6;
  return {
    aiCredits: round(Math.max(0, now.aiCredits - (base?.aiCredits ?? 0))),
    premiumRequests: round(Math.max(0, now.premiumRequests - (base?.premiumRequests ?? 0))),
  };
}

/* ------------------------------- job lifecycle ---------------------------- */

/**
 * Validate delegation arguments shared by delegate and fanOut. Throws before
 * any worker is started so bad requests fail fast and cheaply.
 */
function validateCommonArgs(args, label) {
  const persona = args.persona ?? "builder";
  if (!PERSONA_NAMES.includes(persona)) throw fail("PERSONA_INVALID", `${label}: "persona" must be one of ${PERSONA_NAMES.join("|")}`);
  if (args.effort != null && ![...EFFORT_LEVELS, "off"].includes(args.effort)) {
    throw fail("EFFORT_INVALID", `${label}: "effort" must be one of ${[...EFFORT_LEVELS, "off"].join("|")}`);
  }
  if (args.autoRetry != null && typeof args.autoRetry !== "boolean") throw fail("AUTO_RETRY_INVALID", `${label}: "autoRetry" must be a boolean`);
  const skills = resolveSkillNames(args.skills, { label: `${label}: "skills"` });
  return { persona, skills };
}

/**
 * Start one worker for a job and send it the first prompt.
 * @returns {Promise<{ entry: object, job: object }>}
 */
async function startJob(opts) {
  const { cwd, task, selection, persona, skills, jobId } = opts;
  const config = loadConfig();
  const policy = workerToolPolicy(persona, config.permissions);
  const entry = { jobId, cwd, persona, nudges: 0, terminal: false, finalizing: null, outcome: null };
  activitySink.bind(cwd, jobId);

  const session = await startCopilotSession({
    cwd,
    model: selection.model.id,
    effort: selection.effort,
    resumeSessionId: opts.resumeSessionId ?? null,
    allowTools: policy.allowTools,
    denyTools: policy.denyTools,
    rules: () => workerToolPolicy(persona, loadConfig().permissions).rules,
    unmatched: "ask",
    onActivity: (kind, text) => activitySink.record(jobId, kind, text),
    onTurnEnd: (turn) => {
      entry.finalizing = finalizeTurn(entry, turn).catch(async (err) => {
        emitLog("error", `finalizing job ${jobId} failed — ${err.message}`, { force: true });
        // Never leave a job neither running nor finished: record the failure.
        if (!entry.terminal) {
          const error = { name: "FinalizeError", message: `could not finalize the turn: ${err.message}` };
          await terminate(entry, turn, "failed", { errorMessage: error.message, error }).catch(() => {});
        }
      });
    },
  });
  entry.session = session;
  entry.baseAccounting = opts.resumeSessionId ? readSessionAccounting(opts.resumeSessionId) : null;
  rememberLiveCatalog(session.models);
  activitySink.bind(cwd, jobId, session.id);

  const defaultSkills = persona === "reviewer" ? DEFAULT_REVIEWER_SKILLS : DEFAULT_BUILDER_SKILLS;
  const digest = renderSkillDigest([...new Set([...defaultSkills, ...skills])]);
  const job = createJobRecord(cwd, "delegate", {
    id: jobId,
    sessionID: session.id,
    model: session.model,
    effort: selection.effort ?? null,
    tier: selection.model.tier ?? null,
    persona,
    directory: cwd,
    gitBase: snapshotGitHead(cwd),
    task,
    autoRetry: opts.autoRetry === true,
    workerPid: session.pid ?? null,
    ...(skills.length > 0 ? { skills } : {}),
    ...(opts.resumeSessionId ? { resumedFrom: opts.resumeSessionId } : {}),
    ...(opts.retryOf ? { retryOf: opts.retryOf.id, retryOfSession: opts.retryOf.sessionID ?? null } : {}),
    ...(opts.fanOutId ? { fanOutId: opts.fanOutId, fanOutIndex: opts.fanOutIndex } : {}),
  });
  upsertJob(cwd, { id: job.id, status: "running", phase: "delegated" });
  live.set(session.id, entry);
  pruneFinished();

  session.prompt(buildWorkerPrompt({ contract: config.contract, cwd, jobId, task, persona, skillsDigest: digest }));
  activitySink.record(
    jobId,
    "delegate",
    `job ${jobId} started — model=${session.model}${selection.effort ? ` effort=${selection.effort}` : ""} persona=${persona}${opts.resumeSessionId ? ` resumedFrom=${opts.resumeSessionId}` : ""}`
  );
  emitLog("notice", `delegate started job=${jobId} model=${session.model}${selection.effort ? ` effort=${selection.effort}` : ""} persona=${persona}`, {
    force: true,
    data: { jobId, sessionID: session.id, model: session.model, effort: selection.effort ?? null, persona },
  });
  return { entry, job };
}

/**
 * React to the end of a worker turn: nudge an empty builder turn once,
 * auto-retry a retryable failure, otherwise close the worker and record the
 * outcome on the job.
 */
async function finalizeTurn(entry, turn) {
  if (entry.terminal) return;
  const { session, jobId, cwd } = entry;
  const config = loadConfig();
  const job = jobById(cwd, jobId);

  // Cancelled from outside this server (/copilot:cancel stops the worker
  // process): whatever the turn looked like, the user asked for a stop.
  if (job?.status === "cancelled") {
    await terminate(entry, turn, "cancelled", {});
    return;
  }

  if (turn.error || (session.status === "exited" && turn.stopReason !== "cancelled" && !turn.assistant.trim())) {
    const error = turn.error ?? { name: "WorkerExited", message: "the Copilot worker exited before finishing the turn" };
    const escalation = buildEscalation(error, config, cachedCatalogModels(config), session.model);
    await terminate(entry, turn, "failed", { errorMessage: error.message, error, escalation });
    await maybeAutoRetry(entry, job, escalation, config);
    return;
  }

  if (turn.stopReason === "cancelled") {
    await terminate(entry, turn, "cancelled", {});
    return;
  }

  const hasText = turn.assistant.trim().length > 0;
  const hasReport = readReportSnapshot(cwd, jobId, { peek: true }) !== null;
  if (entry.persona === "builder" && !hasText && !hasReport) {
    if (entry.nudges < MAX_NUDGES && session.status !== "exited") {
      entry.nudges += 1;
      upsertJob(cwd, { id: jobId, nudgedCount: entry.nudges, nudgedAt: new Date().toISOString() });
      activitySink.record(jobId, "nudge", "turn ended with no output — nudging the worker once");
      session.prompt(nudgePrompt(cwd, jobId));
      return;
    }
    const error = { name: "EmptyOutput", message: "the worker ended its turn without any output or report (nudge exhausted)" };
    const escalation = { kind: "empty", retryable: true, ...(session.model ? { suggestModel: session.model } : {}), reason: "worker produced no output; re-delegate suggested" };
    await terminate(entry, turn, "failed", { errorMessage: error.message, error, escalation });
    await maybeAutoRetry(entry, job, escalation, config);
    return;
  }

  await terminate(entry, turn, "completed", {});
}

/** Close the worker and persist the job's final state. */
async function terminate(entry, turn, status, extra) {
  entry.terminal = true;
  const { session, jobId, cwd } = entry;
  await session.close({ graceMs: 2000 }).catch(() => {});
  const accounting = accountingDelta(session.id, entry.baseAccounting);
  const response = (turn?.assistant ?? "").trim();
  const usage = turn?.usage ?? null;
  writeJson(jobDataPath(cwd, jobId), {
    sessionID: session.id,
    status,
    stopReason: turn?.stopReason ?? null,
    response: response.slice(-RESPONSE_MAX_CHARS),
    reasoningTail: (turn?.reasoning ?? "").slice(-2000),
    tools: session.recentTools(50),
    permissions: session.permissionLog,
    usage,
    ...(extra.error ? { error: extra.error } : {}),
  });
  upsertJob(cwd, {
    id: jobId,
    status,
    phase: status,
    completedAt: new Date().toISOString(),
    stopReason: turn?.stopReason ?? null,
    summary: response.slice(0, 300) || null,
    workerPid: null,
    ...(usage ? { tokens: { input: usage.inputTokens ?? null, output: usage.outputTokens ?? null, cachedRead: usage.cachedReadTokens ?? null } } : {}),
    ...(accounting ? accounting : {}),
    ...(extra.errorMessage ? { errorMessage: extra.errorMessage } : {}),
  });
  entry.outcome = {
    status,
    stopReason: turn?.stopReason ?? null,
    response,
    usage,
    accounting,
    error: extra.error ?? null,
    escalation: extra.escalation ?? null,
    todos: session.todoSummary(),
    tools: session.recentTools(5),
  };
  activitySink.record(
    jobId,
    status === "completed" ? "lifecycle" : "error",
    `job ${status}${extra.errorMessage ? ` — ${extra.errorMessage}` : ""}${accounting ? ` (credits=${accounting.aiCredits}, premiumRequests=${accounting.premiumRequests})` : ""}`
  );
  emitLog(status === "completed" ? "info" : "warning", `session ${shortId(session.id)} ${status}${extra.errorMessage ? ` — ${extra.errorMessage}` : ""}`, { force: true });
}

/** Re-delegate a failed job once, on the escalation-suggested model. */
async function maybeAutoRetry(entry, job, escalation, config) {
  if (!job?.autoRetry || !escalation?.retryable || job.autoRetriedAs) return;
  if (retryChainDepth(entry.cwd, job) >= maxAutoRetries(config)) return;
  try {
    const retried = await toolDelegate({
      task: job.task,
      cwd: entry.cwd,
      ...(escalation.suggestModel ? { model: escalation.suggestModel } : {}),
      persona: job.persona ?? "builder",
      ...(Array.isArray(job.skills) ? { skills: job.skills } : {}),
      retryOf: job.id,
      autoRetry: true,
    });
    upsertJob(entry.cwd, { id: job.id, autoRetriedAs: retried.jobId, autoRetrySession: retried.sessionID });
    entry.outcome = { ...entry.outcome, retried: { jobId: retried.jobId, sessionID: retried.sessionID, model: retried.model } };
    activitySink.record(job.id, "retry", `auto-retried as ${retried.jobId} on ${retried.model}`);
  } catch (err) {
    activitySink.record(job.id, "retry", `auto-retry failed — ${err.message}`);
  }
}

/* ---------------------------------- tools --------------------------------- */

async function toolDelegate(args) {
  const cwd = resolveCwd(args);
  if (!args.task || typeof args.task !== "string" || !args.task.trim()) throw fail("TASK_REQUIRED", 'delegate requires a non-empty "task" string');
  const config = loadConfig();
  const { persona, skills } = validateCommonArgs(args, "delegate");

  let retryTarget = null;
  if (args.retryOf != null) {
    if (typeof args.retryOf !== "string" || !args.retryOf.trim()) throw fail("RETRY_OF_INVALID", "retryOf must be a non-empty job id or prefix");
    const candidates = (loadState(cwd).jobs ?? []).filter((j) => j.type === "delegate" && (j.status === "failed" || j.status === "cancelled"));
    retryTarget = candidates.find((j) => j.id === args.retryOf) ?? null;
    if (!retryTarget) {
      const prefixMatches = candidates.filter((j) => j.id.startsWith(args.retryOf));
      if (prefixMatches.length > 1) throw fail("RETRY_OF_AMBIGUOUS", `retryOf prefix "${args.retryOf}" is ambiguous across ${prefixMatches.length} jobs`);
      retryTarget = prefixMatches[0] ?? null;
    }
    if (!retryTarget) throw fail("RETRY_TARGET_NOT_FOUND", `retryOf "${args.retryOf}" does not match any failed or cancelled delegate job`);
  }
  if (args.resumeSessionID != null && (typeof args.resumeSessionID !== "string" || !args.resumeSessionID.trim())) {
    throw fail("RESUME_SESSION_INVALID", "resumeSessionID must be a non-empty session id");
  }
  if (args.resumeSessionID && live.get(args.resumeSessionID) && !live.get(args.resumeSessionID).terminal) {
    throw fail("SESSION_BUSY", `session ${args.resumeSessionID} is still running; wait for it or abort it first`);
  }

  const cap = Number(config.concurrency?.maxDelegates);
  if (Number.isFinite(cap) && cap > 0 && runningEntries().length >= cap) {
    throw fail("DELEGATE_LIMIT_EXCEEDED", `delegate limit reached: ${runningEntries().length}/${cap} jobs already running (config.concurrency.maxDelegates); wait or abort one first`);
  }
  const verdict = checkBudget(config, loadState(cwd).jobs ?? []);
  if (!verdict.ok) throw fail(verdict.code, verdict.reason);

  const catalog = await getCatalog(cwd);
  const selection = resolveSelection({ modelId: args.model, tier: args.tier, effort: args.effort }, catalog.models, config);
  const jobId = generateJobId("delegate");
  const { entry } = await startJob({
    cwd,
    task: args.task,
    selection,
    persona,
    skills,
    jobId,
    resumeSessionId: args.resumeSessionID ?? null,
    retryOf: retryTarget,
    autoRetry: args.autoRetry === true,
  });

  return {
    sessionID: entry.session.id,
    jobId,
    model: entry.session.model,
    multiplier: selection.model.multiplier ?? null,
    tier: selection.model.tier ?? null,
    effort: selection.effort ?? null,
    source: selection.source,
    reason: selection.reason ?? null,
    persona,
    ...(skills.length > 0 ? { skills } : {}),
    ...(args.resumeSessionID ? { resumedFrom: args.resumeSessionID } : {}),
    ...(retryTarget ? { retryOf: retryTarget.id } : {}),
    reportPath: reportPathFor(cwd, jobId),
    cwd,
    startedAt: new Date().toISOString(),
    nextStep: `Supervise with wait {sessionID: "${entry.session.id}"} until it reports idle.`,
  };
}

/**
 * Fan out MULTIPLE tasks in parallel with ONE call: same resolved model and
 * effort for every task, one job (and one worker) each, a shared fanOutId.
 * mode:"race" supervises inline instead: the first task that finishes cleanly
 * wins and every other session is aborted so losers stop consuming credits.
 */
async function toolFanOut(args, meta) {
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) throw fail("TASKS_REQUIRED", 'fanOut requires a non-empty "tasks" array');
  if (args.tasks.length > 12) throw fail("TASKS_TOO_MANY", "fanOut supports at most 12 tasks per call");
  if (args.titlePrefix != null && (typeof args.titlePrefix !== "string" || !args.titlePrefix.trim())) {
    throw fail("TITLE_PREFIX_INVALID", 'fanOut: "titlePrefix" must be a non-empty string');
  }
  const mode = args.mode ?? "batch";
  if (!["batch", "race"].includes(mode)) throw fail("MODE_INVALID", 'fanOut: "mode" must be "batch" or "race"');

  const entries = args.tasks.map((t, i) => {
    if (typeof t === "string") {
      if (!t.trim()) throw fail("TASKS_INVALID", `tasks[${i}] must be a non-empty string`);
      return { task: t.trim(), cwd: null };
    }
    if (t && typeof t === "object" && !Array.isArray(t) && typeof t.task === "string" && t.task.trim()) {
      if (t.cwd != null) resolveCwd({ cwd: t.cwd });
      return { task: t.task.trim(), cwd: t.cwd ?? null };
    }
    throw fail("TASKS_INVALID", `tasks[${i}] must be a non-empty string or {task, cwd?} object`);
  });

  const cwd = resolveCwd(args);
  const config = loadConfig();
  const { persona, skills } = validateCommonArgs(args, "fanOut");
  const cap = Number(config.concurrency?.maxDelegates);
  if (Number.isFinite(cap) && cap > 0 && runningEntries().length + entries.length > cap) {
    throw fail(
      "DELEGATE_LIMIT_EXCEEDED",
      `delegate limit reached: ${runningEntries().length}/${cap} jobs running and fanOut wants ${entries.length} more (config.concurrency.maxDelegates); wait or abort first`
    );
  }
  const verdict = checkBudget(config, loadState(cwd).jobs ?? []);
  if (!verdict.ok) throw fail(verdict.code, verdict.reason);

  const catalog = await getCatalog(cwd);
  const selection = resolveSelection({ modelId: args.model, tier: args.tier, effort: args.effort }, catalog.models, config);
  const prefix = (typeof args.titlePrefix === "string" ? args.titlePrefix.replace(/\s+/g, " ").trim() : "Fanout").slice(0, 40);
  const fanOutId = generateJobId("fanout");
  const n = entries.length;

  const settled = await Promise.all(
    entries.map(async (item, i) => {
      const taskCwd = item.cwd ?? cwd;
      try {
        const jobId = generateJobId("delegate");
        const { entry } = await startJob({ cwd: taskCwd, task: item.task, selection, persona, skills, jobId, fanOutId, fanOutIndex: i });
        return { ok: true, value: { jobId, sessionID: entry.session.id, index: i, ...(item.cwd ? { cwd: taskCwd } : {}), title: `${prefix} ${i + 1}/${n}` } };
      } catch (err) {
        return { ok: false, value: { index: i, error: err.message, ...(err.code ? { code: err.code } : {}) } };
      }
    })
  );
  const jobs = settled.filter((r) => r.ok).map((r) => r.value);
  const failed = settled.filter((r) => !r.ok).map((r) => r.value);
  const batchResult = {
    fanOutId,
    total: n,
    started: jobs.length,
    failed,
    jobs,
    model: selection.model.id,
    effort: selection.effort ?? null,
    persona,
    ...(skills.length > 0 ? { skills } : {}),
  };

  if (mode !== "race") {
    emitLog("notice", `fanOut ${jobs.length}/${n} task(s) started (batch)`, { force: true });
    return {
      ...batchResult,
      nextStep: jobs.length > 0 ? `Supervise with waitAll on these sessionIDs: ${jobs.map((j) => j.sessionID).join(", ")}` : "No task could be started.",
    };
  }
  if (jobs.length === 0) return { ...batchResult, mode, winner: null, aborted: [], note: "No task could be started." };

  // ---- race supervision: first clean finish wins, the rest get aborted ----
  // Short slices: a finished runner is noticed within a couple of seconds
  // even while its siblings keep working.
  const RACE_SLICE_SEC = 2;
  const totalSec = Number.isFinite(args.timeoutSec) ? args.timeoutSec : DEFAULT_WAIT_TIMEOUT_SEC;
  const raceEmit = buildProgressEmitter(meta, { totalSec });
  const deadline = Date.now() + totalSec * 1000;
  let winner = null;
  while (winner === null && Date.now() < deadline) {
    const sliceSec = Math.min(RACE_SLICE_SEC, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
    const slice = await Promise.all(jobs.map((j) => toolWait({ sessionID: j.sessionID, cwd: j.cwd ?? cwd, timeoutSec: sliceSec }, { progressToken: null, raceSlice: true })));
    const cleanIdx = slice.findIndex((r) => r.status === "idle" && r.outcome === "completed");
    if (cleanIdx >= 0) {
      winner = { ...jobs[cleanIdx], outcome: slice[cleanIdx] };
      break;
    }
    if (slice.every((r) => r.status === "idle" || r.status === "needsInput")) break;
    raceEmit?.(`race ${jobs.length} runners — ${slice.filter((r) => r.status === "timeout").length} still working; ${jobs.map((j, i) => `${shortId(j.sessionID)}: ${slice[i]?.status ?? "?"}`).join(", ")}`);
  }

  const aborted = [];
  for (const j of jobs) {
    if (winner && j.sessionID === winner.sessionID) continue;
    const entry = live.get(j.sessionID);
    if (!entry || entry.terminal) continue;
    await toolAbort({ sessionID: j.sessionID, cwd: j.cwd ?? cwd });
    upsertJob(j.cwd ?? cwd, { id: j.jobId, cancelledReason: winner ? "race-loser" : "race-no-winner" });
    aborted.push({ sessionID: j.sessionID, jobId: j.jobId, index: j.index });
  }

  if (!winner) {
    return {
      ...batchResult,
      mode,
      winner: null,
      aborted,
      note:
        aborted.length > 0
          ? "Race ended without a clean winner (blocked on permissions or errors); the others were aborted."
          : "Race deadline hit before any task finished.",
    };
  }
  return {
    ...batchResult,
    mode,
    winner: {
      jobId: winner.jobId,
      sessionID: winner.sessionID,
      index: winner.index,
      response: winner.outcome.response ?? null,
      aiCredits: winner.outcome.aiCredits ?? null,
      report: winner.outcome.report ?? null,
    },
    aborted,
    nextStep: `Winner session ${winner.sessionID} completed its task; verify its artifacts yourself.`,
  };
}

/**
 * Effective wait duration. With a progressToken the caller gets live MCP
 * progress frames, so a long blocking poll is fine: explicit timeoutSec wins,
 * otherwise the 600s default. Without one nothing would stream to the UI and
 * Claude Code backgrounds calls that block for minutes, so the wait is capped
 * at one activity slice and the supervisor chains calls until idle.
 */
export function effectiveWaitTimeoutSec(args = {}, meta = {}) {
  if (meta?.progressToken !== undefined && meta?.progressToken !== null) {
    return Number.isFinite(args.timeoutSec) ? Math.max(1, args.timeoutSec) : DEFAULT_WAIT_TIMEOUT_SEC;
  }
  const envSlice = Number.parseInt(process.env.CP_WAIT_SLICE_SEC ?? "", 10);
  const slice = Number.isFinite(envSlice) && envSlice > 0 ? envSlice : WAIT_SLICE_SEC;
  return Math.min(Number.isFinite(args.timeoutSec) ? Math.max(1, args.timeoutSec) : slice, slice);
}

/** Wait result for a job whose worker has finished. */
function idleResult(sessionID, entry, job, jobCwd) {
  const outcome = entry?.outcome ?? storedOutcome(job, jobCwd);
  if (outcome?.retried) {
    return {
      status: "retried",
      sessionID,
      jobId: job?.id ?? entry?.jobId ?? null,
      retryJobId: outcome.retried.jobId,
      newSessionID: outcome.retried.sessionID,
      model: outcome.retried.model,
      originalError: outcome.error,
      reason: outcome.escalation?.reason ?? "retryable failure escalated automatically",
      nextStep: `Supervise the retry with wait {sessionID: "${outcome.retried.sessionID}"}.`,
    };
  }
  const report = job && outcome?.status === "completed" ? readReportSnapshot(jobCwd, job.id) : null;
  // The contract makes the report mandatory; a "completed" turn without one
  // is a contract breach the supervisor must see, not a silent success.
  const reportMissing = Boolean(job && outcome?.status === "completed" && !report);
  return {
    status: "idle",
    outcome: outcome?.status ?? job?.status ?? "unknown",
    sessionID,
    jobId: job?.id ?? entry?.jobId ?? null,
    model: job?.model ?? entry?.session?.model ?? null,
    effort: job?.effort ?? null,
    stopReason: outcome?.stopReason ?? job?.stopReason ?? null,
    error: outcome?.error ?? null,
    ...(outcome?.escalation ? { escalation: outcome.escalation } : {}),
    ...(report ? { report } : {}),
    ...(reportMissing ? { reportMissing: true, warning: `the worker finished without writing its report (${reportPathFor(jobCwd, job.id)}); treat the run as unverified` } : {}),
    aiCredits: job?.aiCredits ?? outcome?.accounting?.aiCredits ?? null,
    premiumRequests: job?.premiumRequests ?? outcome?.accounting?.premiumRequests ?? null,
    tokens: job?.tokens ?? null,
    todos: outcome?.todos ?? null,
    tools: outcome?.tools ?? [],
    response: outcome?.response ?? "",
  };
}

/** Outcome of a job finished by an earlier server process, from disk. */
function storedOutcome(job, jobCwd) {
  if (!job) return null;
  const data = readJson(jobDataPath(jobCwd, job.id)) ?? {};
  return {
    status: job.status,
    stopReason: data.stopReason ?? job.stopReason ?? null,
    response: data.response ?? "",
    error: data.error ?? (job.errorMessage ? { name: "Error", message: job.errorMessage } : null),
    ...(job.autoRetriedAs ? { retried: { jobId: job.autoRetriedAs, sessionID: job.autoRetrySession ?? null, model: null } } : {}),
    tools: data.tools ?? [],
  };
}

async function toolWait(args, meta) {
  if (!args.sessionID || typeof args.sessionID !== "string") throw fail("SESSION_ID_REQUIRED", 'wait requires "sessionID"');
  const cwd = resolveCwd(args);
  const sessionID = args.sessionID;
  const autoSliced = meta?.progressToken === undefined || meta?.progressToken === null;
  const timeoutSec = meta?.raceSlice ? Math.max(1, args.timeoutSec ?? 1) : effectiveWaitTimeoutSec(args, meta);
  const emit = buildProgressEmitter(meta, { totalSec: timeoutSec });
  const deadline = Date.now() + timeoutSec * 1000;
  const entry = live.get(sessionID) ?? null;
  const found = findJobRecord(cwd, sessionID);
  const job = found.job;
  const jobCwd = found.jobCwd;

  if (!entry) {
    if (!job) throw fail("SESSION_NOT_FOUND", `no delegated job is known for session ${sessionID}`);
    if (job.status === "running") {
      // The worker belonged to an MCP server process that is gone (Claude
      // Code restarted the server, or the session ended). The Copilot session
      // itself is intact on disk and can be continued.
      upsertJob(jobCwd, {
        id: job.id,
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: "worker lost: the MCP server that owned this job's Copilot process is no longer running",
        workerPid: null,
      });
      return {
        status: "idle",
        outcome: "failed",
        sessionID,
        jobId: job.id,
        error: { name: "WorkerLost", message: "the Copilot worker for this job is no longer running" },
        escalation: { kind: "worker", retryable: true, reason: "worker lost with its MCP server" },
        nextStep: `Continue the same conversation with delegate {task: "<what remains>", resumeSessionID: "${sessionID}"} or start over with delegate {retryOf: "${job.id}"}.`,
      };
    }
    return idleResult(sessionID, null, jobById(jobCwd, job.id) ?? job, jobCwd);
  }

  const session = entry.session;
  for (;;) {
    if (!entry.terminal && session.busy) {
      const pending = session.pendingList();
      if (pending.length > 0) {
        activitySink.record(entry.jobId, "wait", `needsInput — ${pending.length} permission(s) pending`);
        emitLog("notice", `session ${shortId(sessionID)} needs input — ${pending.length} permission(s) pending`, { force: true });
        const turn = session.turn;
        return {
          status: "needsInput",
          sessionID,
          jobId: entry.jobId,
          permissions: pending.map((p) => ({ id: p.id, kind: p.kind, title: p.title, command: p.subject, askedAt: p.askedAt })),
          progress: { tail: (turn?.assistant ?? "").slice(-300), todos: session.todoSummary() },
          nextStep: 'Decide each request with respond {sessionID, permissionID, response:"once"|"always"|"reject"}. Note: "reject" ends the worker\'s current turn.',
        };
      }
    }

    if (!session.busy || entry.terminal) {
      if (entry.finalizing) await entry.finalizing;
      if (!entry.terminal && session.busy) continue; // nudged: a new turn started
      if (entry.terminal) {
        const jobNow = jobById(entry.cwd, entry.jobId) ?? job;
        return idleResult(sessionID, entry, jobNow, entry.cwd);
      }
    }

    if (Date.now() >= deadline) {
      const turn = session.turn;
      activitySink.record(entry.jobId, "wait", `timeout after ${timeoutSec}s — still busy`);
      return {
        status: "timeout",
        sessionID,
        jobId: entry.jobId,
        progress: {
          tail: (turn?.assistant ?? "").slice(-160),
          reasoningTail: (turn?.reasoning ?? "").slice(-160),
          tools: session.recentTools(3),
          todos: session.todoSummary(),
        },
        ...(autoSliced ? { sliced: true } : {}),
        nextStep:
          "the delegated session is STILL RUNNING — nothing was lost; call wait {sessionID} again to keep supervising until it reports idle",
      };
    }

    await session.waitForChange(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    emit?.(`waiting ${shortId(sessionID)} — ${activitySink.summary(sessionID) || "no output yet"}`);
  }
}

async function toolWaitAll(args, meta) {
  const ids = Array.isArray(args.sessionIDs) ? args.sessionIDs : [];
  if (ids.length === 0 || ids.some((s) => typeof s !== "string" || !s.trim())) {
    throw fail("SESSION_IDS_REQUIRED", 'waitAll requires a non-empty "sessionIDs" string array');
  }
  if (ids.length > 12) throw fail("SESSION_IDS_TOO_MANY", "waitAll supports at most 12 sessions per call");
  const waitFor = args.waitFor ?? null;
  if (waitFor != null && (!Number.isInteger(waitFor) || waitFor < 1 || waitFor > ids.length)) {
    throw fail("WAIT_FOR_INVALID", `waitFor must be an integer between 1 and ${ids.length} (got ${JSON.stringify(args.waitFor)})`);
  }
  const summarize = (results) => ({
    total: results.length,
    idle: results.filter((r) => r.status === "idle").length,
    needsInput: results.filter((r) => r.status === "needsInput").length,
    timeout: results.filter((r) => r.status === "timeout").length,
    retried: results.filter((r) => r.status === "retried").length,
    error: results.filter((r) => r.status === "error").length,
  });
  const asError = (sessionID) => (err) => ({ status: "error", sessionID, error: err?.message ?? String(err) });

  if (waitFor == null) {
    const timeoutSec = effectiveWaitTimeoutSec(args, meta);
    const results = await Promise.all(ids.map((sessionID) => toolWait({ ...args, sessionID, timeoutSec }, meta).catch(asError(sessionID))));
    const summary = summarize(results);
    return {
      sessionIDs: ids,
      results,
      summary,
      ...(summary.timeout > 0
        ? {
            sliced: true,
            note: `${summary.timeout} session(s) still running past this call's deadline — nothing was cancelled. Re-issue waitAll (or wait per sessionID) until they report idle.`,
          }
        : {}),
    };
  }

  // Early exit once `waitFor` sessions reach a terminal state.
  const totalSec = effectiveWaitTimeoutSec(args, meta);
  const deadline = Date.now() + totalSec * 1000;
  const collected = new Map();
  let pending = [...ids];
  while (pending.length > 0 && collected.size < waitFor && Date.now() < deadline) {
    const sliceSec = Math.min(2, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
    const settled = await Promise.all(pending.map((sessionID) => toolWait({ ...args, sessionID, timeoutSec: sliceSec }, { raceSlice: true }).catch(asError(sessionID))));
    const stillPending = [];
    for (const r of settled) {
      if (r.status === "timeout") stillPending.push(r.sessionID);
      else collected.set(r.sessionID, r);
    }
    pending = stillPending;
  }
  const results = ids.map((sessionID) => collected.get(sessionID) ?? { status: "timeout", sessionID });
  const summary = summarize(results);
  return {
    sessionIDs: ids,
    waitFor,
    partial: true,
    results,
    summary,
    ...(summary.timeout > 0
      ? { note: `${summary.timeout} session(s) still running — nothing was cancelled. Re-issue waitAll until they report idle.` }
      : {}),
  };
}

async function toolStatus(args) {
  const cwd = resolveCwd(args);
  if (!args.sessionID) {
    const jobs = (loadState(cwd).jobs ?? [])
      .filter((j) => j.type === "delegate")
      .sort((a, b) => new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime())
      .slice(0, 20)
      .map((j) => ({
        id: j.id,
        status: j.status,
        sessionID: j.sessionID ?? null,
        model: j.model ?? null,
        effort: j.effort ?? null,
        tier: j.tier ?? null,
        persona: j.persona ?? null,
        live: Boolean(j.sessionID && live.get(j.sessionID) && !live.get(j.sessionID).terminal),
        retryOf: j.retryOf ?? null,
        resumedFrom: j.resumedFrom ?? null,
        errorMessage: j.errorMessage ?? null,
        aiCredits: Number.isFinite(j.aiCredits) ? j.aiCredits : null,
        createdAt: j.createdAt ?? null,
        completedAt: j.completedAt ?? null,
      }));
    return { jobs };
  }
  const entry = live.get(args.sessionID);
  const { job } = findJobRecord(cwd, args.sessionID);
  if (!entry) {
    if (!job) throw fail("SESSION_NOT_FOUND", `no delegated job is known for session ${args.sessionID}`);
    return { sessionID: args.sessionID, live: false, job: { id: job.id, status: job.status, model: job.model ?? null, errorMessage: job.errorMessage ?? null, summary: job.summary ?? null } };
  }
  const s = entry.session;
  const turn = s.turn ?? s.lastTurn;
  return {
    sessionID: args.sessionID,
    live: !entry.terminal,
    state: entry.terminal ? entry.outcome?.status ?? "finished" : s.busy ? (s.pending.size > 0 ? "needsInput" : "busy") : "idle",
    jobId: entry.jobId,
    model: s.model,
    effort: s.effort,
    workerPid: entry.terminal ? null : s.pid ?? null,
    turn: turn
      ? {
          index: turn.index,
          startedAt: new Date(turn.startedAt).toISOString(),
          finishedAt: turn.finishedAt ? new Date(turn.finishedAt).toISOString() : null,
          stopReason: turn.stopReason,
          assistantTail: turn.assistant.slice(-400),
          tools: s.recentTools(8),
        }
      : null,
    todos: s.todoSummary(),
    pendingPermissions: s.pendingList().map((p) => ({ id: p.id, command: p.subject })),
    contextUsage: s.contextUsage,
    lastActivityAt: new Date(s.lastActivityAt).toISOString(),
  };
}

/**
 * Tail a delegation's activity log. Resolution: jobId → sessionID → most
 * recent delegate job of the workspace.
 */
async function toolLogs(args) {
  const cwd = resolveCwd(args);
  const jobs = loadState(cwd).jobs ?? [];
  let job = null;
  if (args.jobId != null) {
    if (typeof args.jobId !== "string" || !args.jobId.trim()) throw fail("JOB_ID_INVALID", "jobId must be a non-empty job id or prefix");
    const prefixMatches = jobs.filter((j) => j.id.startsWith(args.jobId));
    job = jobs.find((j) => j.id === args.jobId) ?? (prefixMatches.length === 1 ? prefixMatches[0] : null);
    if (!job) throw fail("JOB_NOT_FOUND", `jobId "${args.jobId}" matched ${prefixMatches.length} jobs; use the full id or a unique prefix`);
  } else if (args.sessionID != null) {
    job = findJobRecord(cwd, args.sessionID).job;
  } else {
    job =
      [...jobs]
        .filter((j) => j.type === "delegate")
        .sort((a, b) => new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime())[0] ?? null;
  }
  if (!job) throw fail("LOGS_NO_JOBS", "no delegate job found for this workspace yet");
  const lines = Math.min(Math.max(Number.isInteger(args.lines) ? args.lines : 80, 1), 400);
  let logLines = activitySink.tail(job.id, lines);
  const mirror = jobLogPath(job.directory ?? cwd, job.id);
  let hasMirror = false;
  try {
    hasMirror = fs.statSync(mirror).size > 0;
  } catch {}
  if (logLines.length === 0 && hasMirror) logLines = tailLines(mirror, lines);
  const entry = job.sessionID ? live.get(job.sessionID) : null;
  const turn = entry && !entry.terminal ? entry.session.turn : null;
  return {
    jobId: job.id,
    sessionID: job.sessionID ?? null,
    status: job.status ?? null,
    model: job.model ?? null,
    effort: job.effort ?? null,
    errorMessage: job.errorMessage ?? null,
    ...(hasMirror ? { logPath: mirror } : {}),
    lines: logLines,
    live: { running: Boolean(turn), assistantTail: (turn?.assistant ?? "").slice(-800), reasoningTail: (turn?.reasoning ?? "").slice(-800) },
  };
}

async function toolDiff(args) {
  if (!args.sessionID || typeof args.sessionID !== "string") throw fail("SESSION_ID_REQUIRED", 'diff requires "sessionID"');
  const cwd = resolveCwd(args);
  const { job, jobCwd } = findJobRecord(cwd, args.sessionID);
  const result = diffSinceSnapshot(job?.directory ?? jobCwd, { base: job?.gitBase ?? null });
  return { sessionID: args.sessionID, jobId: job?.id ?? null, model: job?.model ?? null, status: job?.status ?? null, ...result };
}

async function toolRespond(args) {
  if (!args.sessionID || !args.permissionID) throw fail("ARGS_REQUIRED", 'respond requires "sessionID" and "permissionID"');
  if (!["once", "always", "reject"].includes(args.response)) throw fail("RESPONSE_INVALID", 'response must be "once", "always" or "reject"');
  const entry = live.get(args.sessionID);
  if (!entry || entry.terminal) throw fail("SESSION_NOT_LIVE", `session ${args.sessionID} has no running worker in this server`);
  const responded = entry.session.respond(args.permissionID, args.response);
  if (!responded) throw fail("PERMISSION_NOT_FOUND", `no pending permission "${args.permissionID}" on session ${args.sessionID}`);
  return { responded, permissionID: args.permissionID, response: args.response, remaining: entry.session.pendingList().length };
}

async function toolAbort(args) {
  if (!args.sessionID || typeof args.sessionID !== "string") throw fail("SESSION_ID_REQUIRED", 'abort requires "sessionID"');
  const cwd = resolveCwd(args);
  const entry = live.get(args.sessionID);
  if (!entry) {
    const { job, jobCwd } = findJobRecord(cwd, args.sessionID);
    if (job?.status === "running") {
      upsertJob(jobCwd, { id: job.id, status: "cancelled", completedAt: new Date().toISOString(), workerPid: null });
    }
    return { aborted: false, sessionID: args.sessionID, note: "no running worker for this session in this server" };
  }
  if (entry.terminal) return { aborted: false, sessionID: args.sessionID, note: `job already ${entry.outcome?.status ?? "finished"}` };
  const session = entry.session;
  if (session.busy) {
    session.cancel();
    await Promise.race([session.settled(), new Promise((r) => setTimeout(r, 10_000))]);
    if (entry.finalizing) await entry.finalizing;
  }
  if (!entry.terminal) await terminate(entry, session.lastTurn, "cancelled", {});
  return { aborted: true, sessionID: args.sessionID, jobId: entry.jobId };
}

/**
 * Stop workers this plugin started:
 * 1. live workers of this server in scope: running turns are cancelled (the
 *    session stays resumable), processes closed, jobs marked cancelled;
 * 2. orphans: jobs still marked running whose recorded worker pid is alive
 *    and identity-checked as `copilot --acp` (anything else is refused);
 * 3. opt-in: delete the Copilot session records of finished jobs, and the
 *    disk hygiene sweep.
 * Scope: the workspace by default; all:true covers every workspace.
 */
async function toolShutdown(args) {
  for (const key of ["all", "deleteSessions", "cleanState"]) {
    if (args[key] != null && typeof args[key] !== "boolean") throw fail(`${key.toUpperCase()}_INVALID`, `shutdown: "${key}" must be a boolean`);
  }
  const cwd = resolveCwd(args);
  const scopeAll = args.all === true;
  const inScope = (dir) => scopeAll || dir === cwd;

  const stopped = [];
  for (const [sessionID, entry] of live) {
    if (entry.terminal || !inScope(entry.cwd)) continue;
    await toolAbort({ sessionID, cwd: entry.cwd }).catch(() => {});
    upsertJob(entry.cwd, { id: entry.jobId, cancelledBy: "shutdown" });
    stopped.push({ sessionID, jobId: entry.jobId });
  }

  const orphans = [];
  const refused = [];
  const workspaces = scopeAll ? allWorkspaceStates() : [{ cwd, jobs: loadState(cwd).jobs ?? [] }];
  for (const ws of workspaces) {
    for (const job of ws.jobs) {
      if (job.type !== "delegate" || job.status !== "running" || live.has(job.sessionID)) continue;
      const pid = job.workerPid;
      if (Number.isInteger(pid) && isProcessAlive(pid)) {
        const command = getProcessCommand(pid);
        if (/copilot/i.test(command) && /--acp\b/.test(command)) {
          const res = await stopProcessTree(pid, { graceMs: 3000 });
          orphans.push({ jobId: job.id, pid, outcome: res.outcome });
        } else {
          refused.push({ jobId: job.id, pid, reason: "pid is not a copilot --acp process (recycled pid?)" });
        }
      }
      upsertJob(ws.cwd, { id: job.id, status: "cancelled", completedAt: new Date().toISOString(), cancelledBy: "shutdown", workerPid: null });
    }
  }

  let deletedSessions = 0;
  if (args.deleteSessions === true) {
    for (const ws of scopeAll ? allWorkspaceStates() : [{ cwd, jobs: loadState(cwd).jobs ?? [] }]) {
      for (const job of ws.jobs) {
        if (job.type !== "delegate" || job.status === "running" || !job.sessionID || live.get(job.sessionID)?.terminal === false) continue;
        if (deleteCopilotSession(job.sessionID)) deletedSessions += 1;
      }
    }
  }

  const hygiene = args.cleanState === true ? await runHygieneSweep() : null;
  emitLog("info", `shutdown done — stopped ${stopped.length} worker(s), ${orphans.length} orphan(s), refused ${refused.length}`, { force: true });
  return {
    scope: scopeAll ? "all" : "workspace",
    stopped,
    orphans,
    refused,
    ...(args.deleteSessions === true ? { deletedSessions } : {}),
    ...(hygiene
      ? {
          hygiene: {
            removedDirs: hygiene.removedDirs.length,
            removedJobFiles: hygiene.removedJobFiles.length,
            removedTmpFiles: hygiene.removedTmpFiles.length,
            removedReports: hygiene.removedReports,
            errors: hygiene.errors,
          },
        }
      : {}),
  };
}

function allWorkspaceStates() {
  let hashes = [];
  try {
    hashes = fs.readdirSync(stateBase());
  } catch {
    return [];
  }
  const out = [];
  for (const h of hashes) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(stateBase(), h, "state.json"), "utf8"));
      const jobs = data.jobs ?? [];
      const dir = jobs.find((j) => typeof j.directory === "string")?.directory;
      if (dir) out.push({ cwd: dir, jobs });
    } catch {}
  }
  return out;
}

/** Delete one Copilot session record (opt-in GC for finished delegations). */
function deleteCopilotSession(sessionId) {
  if (typeof sessionId !== "string" || !/^[0-9a-f-]{16,64}$/i.test(sessionId)) return false;
  const root = path.join(copilotHome(), "session-state");
  const dir = path.join(root, sessionId);
  if (path.dirname(dir) !== root || !fs.existsSync(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function toolDoctor(args) {
  const cwd = resolveCwd(args);
  const report = await runDiagnostics({ cwd, config: loadConfig(), checkBinaries: true });
  return { ok: report.ok, platform: report.platform, node: report.node, checks: report.checks, report: formatDoctorReport(report) };
}

const SESSION_ID = { type: "string", description: "Copilot session id returned by delegate/fanOut" };
const CWD = { type: "string", description: "Workspace directory (absolute; default: the project Claude Code runs in)" };
const MODEL_ARGS = {
  model: { type: "string", description: "Explicit Copilot model id (see the models tool); overrides tier" },
  tier: { type: "number", description: "Tier 0-3 when no explicit model (0 cheapest, 3 premium multiplier)" },
  effort: { type: "string", enum: [...EFFORT_LEVELS, "off"], description: "Reasoning effort; default from effortPolicy. off = the model's own default" },
  persona: { type: "string", enum: PERSONA_NAMES, description: "builder (default): may edit the workspace. reviewer: read-only, may only write its report file" },
  skills: { type: "array", items: { type: "string", enum: SKILL_NAMES }, maxItems: 3, description: "Plugin skill digests appended to the worker prompt" },
};

const TOOLS = [
  {
    name: "models",
    title: "Model catalog",
    description:
      "List the Copilot models this account can delegate to, merged with config tiers: id, tier, premium multiplier (e.g. 0.33x/1x/15x), price category, plus the effort policy, a selection hint and today's budget usage.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { cwd: CWD, refresh: { type: "boolean", description: "Re-read the live catalog from Copilot instead of the cache" } },
    },
  },
  {
    name: "delegate",
    title: "Delegate task",
    description:
      "Delegate a task to a GitHub Copilot CLI worker asynchronously. Returns immediately with sessionID/jobId. Use wait to observe progress.",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: "Full task description with goal, scope files, verifiable criteria and test command" },
        cwd: CWD,
        ...MODEL_ARGS,
        retryOf: { type: "string", description: "Job id or id prefix of a failed/cancelled delegate job this run retries" },
        resumeSessionID: { type: "string", description: "Existing Copilot session id to continue (multi-step work, recovery after a lost worker) instead of starting a new session" },
        autoRetry: { type: "boolean", description: "On a retryable failure (rate limit/quota, upstream error, lost worker, empty output) re-delegate once automatically; wait then returns status 'retried' with the new sessionID" },
      },
    },
  },
  {
    name: "fanOut",
    title: "Fan out tasks",
    description:
      "Delegate MULTIPLE tasks in parallel with one call: same model+effort for all, one Copilot worker per task, shared fanOutId, optional per-task workspace (items may be strings or {task, cwd?} objects). mode:race keeps the first clean finisher and aborts the rest. Supervise a batch with waitAll.",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["tasks"],
      properties: {
        tasks: {
          type: "array",
          items: { anyOf: [{ type: "string" }, { type: "object", properties: { task: { type: "string" }, cwd: { type: "string", description: "Per-task workspace directory (absolute)" } }, required: ["task"] }] },
          minItems: 1,
          maxItems: 12,
        },
        mode: { type: "string", enum: ["batch", "race"], description: "batch (default): return immediately, supervise with waitAll. race: first clean finish wins, others are aborted" },
        timeoutSec: { type: "number", description: "race mode shared deadline seconds (default 600)" },
        cwd: CWD,
        ...MODEL_ARGS,
        titlePrefix: { type: "string", description: "Label prefix for the batch (default Fanout)" },
      },
    },
  },
  {
    name: "wait",
    title: "Wait for session",
    description:
      "Poll a delegated session until it goes idle, needs input (a permission request), or the timeout expires. Without a progressToken each call returns within one 60s slice with an activity snapshot (assistant tail, reasoning, tool calls, todos) — chain calls until idle. With _meta.progressToken it blocks (default 600s) and streams MCP progress frames.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      required: ["sessionID"],
      properties: {
        sessionID: SESSION_ID,
        cwd: CWD,
        timeoutSec: { type: "number", description: "Without a progressToken: capped at the 60s slice. With one: honored as-is (default 600)" },
      },
    },
  },
  {
    name: "waitAll",
    title: "Wait for sessions",
    description:
      "Wait for MULTIPLE delegated sessions in parallel. Returns per-session outcomes plus counts; re-issue until all report idle. waitFor:N returns as soon as N sessions reach a terminal state (idle/needsInput/retried/error).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      required: ["sessionIDs"],
      properties: {
        sessionIDs: { type: "array", items: { type: "string" }, description: "Up to 12 session ids" },
        cwd: CWD,
        timeoutSec: { type: "number", description: "Without a progressToken: capped at the 60s slice. With one: shared deadline (default 600)" },
        waitFor: { type: "integer", description: "Early exit once N sessions reach a terminal state; the rest are reported as timeout" },
      },
    },
  },
  {
    name: "status",
    title: "Session snapshot",
    description:
      "Non-blocking snapshot of a delegated session (state, current turn, recent tool calls, todos, pending permissions, context usage). WITHOUT sessionID: lists recent delegate jobs of the workspace.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { sessionID: { type: "string", description: "Omit to list recent delegate jobs instead" }, cwd: CWD } },
  },
  {
    name: "logs",
    title: "Delegation activity log",
    description:
      "Tail a delegation's activity log to SEE what the Copilot worker is doing: streamed assistant output and reasoning, tool calls, permission decisions, lifecycle transitions. WITHOUT jobId/sessionID: the most recent delegate job.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job id or unique prefix (overrides sessionID)" },
        sessionID: { type: "string", description: "Session id; omit both for the latest delegate job" },
        lines: { type: "integer", description: "How many log lines to tail (default 80, max 400)" },
        cwd: CWD,
      },
    },
  },
  {
    name: "diff",
    title: "Worker workspace changes",
    description:
      "Show what a delegated worker changed since its job started: git diff --stat against the HEAD recorded at delegation time plus untracked files. Read-only; works after completion or abort.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", required: ["sessionID"], properties: { sessionID: SESSION_ID, cwd: CWD } },
  },
  {
    name: "respond",
    title: "Answer permission",
    description: 'Answer a pending permission request of a delegated worker: "once", "always" or "reject" (reject ends the worker\'s current turn).',
    inputSchema: {
      type: "object",
      required: ["sessionID", "permissionID", "response"],
      properties: { sessionID: SESSION_ID, permissionID: { type: "string" }, response: { type: "string", enum: ["once", "always", "reject"] }, cwd: CWD },
    },
  },
  {
    name: "abort",
    title: "Abort session",
    description: "Cancel a running delegated session and stop its worker. The Copilot session stays on disk and can be resumed later.",
    annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: { type: "object", required: ["sessionID"], properties: { sessionID: SESSION_ID, cwd: CWD } },
  },
  {
    name: "shutdown",
    title: "Shutdown workers",
    description:
      "Stop the Copilot workers this plugin started: cancels running turns, closes the worker processes, reaps orphaned workers of earlier server processes (identity-checked — foreign pids are refused) and marks their jobs cancelled. Default scope: current workspace; all:true covers every workspace. deleteSessions:true also deletes the Copilot session records of finished delegations (opt-in GC); cleanState:true runs the disk hygiene sweep.",
    annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD,
        all: { type: "boolean", description: "Every workspace this plugin has delegated in" },
        deleteSessions: { type: "boolean", description: "Also DELETE the Copilot session records (~/.copilot/session-state/<id>) of finished delegate jobs (destructive, opt-in)" },
        cleanState: { type: "boolean", description: "Also run the disk hygiene sweep (stale state dirs, orphaned job files, consumed reports)" },
      },
    },
  },
  {
    name: "doctor",
    title: "Diagnostics",
    description:
      "Run environment diagnostics: copilot binary and version, node version, Copilot authentication, ACP handshake, model catalog, state dir writability.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { cwd: CWD } },
  },
];

const TOOL_HANDLERS = {
  models: toolModels,
  delegate: toolDelegate,
  fanOut: toolFanOut,
  wait: toolWait,
  waitAll: toolWaitAll,
  status: toolStatus,
  logs: toolLogs,
  diff: toolDiff,
  respond: toolRespond,
  abort: toolAbort,
  shutdown: toolShutdown,
  doctor: toolDoctor,
};

/* -------------------------------- json-rpc -------------------------------- */

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Handle one JSON-RPC message and return the response object (null for
 * notifications / malformed input without id).
 * @param {object} msg
 * @returns {Promise<object|null>}
 */
export async function handleRpcMessage(msg) {
  if (msg == null || typeof msg !== "object") return null;
  const hasId = "id" in msg && msg.id !== undefined;

  if (msg.method === "initialize") {
    if (!hasId) return null;
    return rpcResult(msg.id, {
      protocolVersion: PROTOCOL_VERSION,
      // `logging` advertises the notifications/message channel that renders in
      // Claude Code's MCP tab — without it the client never shows server logs.
      capabilities: { tools: {}, logging: {} },
      serverInfo: { name: "copilot-delegate", version: "1.0.0" },
    });
  }

  if (msg.method === "logging/setLevel") {
    if (!hasId) return null;
    const active = setLogLevel(msg.params?.level);
    emitLog("info", `log level set to "${active}"`, { force: true });
    return rpcResult(msg.id, { level: active });
  }

  if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) return null;

  if (msg.method === "tools/list") return rpcResult(msg.id, { tools: TOOLS });

  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params ?? {};
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      if (!hasId) return null;
      emitLog("warning", `unknown tool "${name}" requested`, { force: true });
      return rpcResult(msg.id, { content: [{ type: "text", text: `Unknown tool "${name}"` }], isError: true });
    }
    try {
      const result = await handler(args ?? {}, msg.params?._meta);
      return rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false });
    } catch (err) {
      emitLog("error", `tool ${name} failed — ${err.message}${err.code ? ` (${err.code})` : ""}`, { force: true });
      return rpcResult(msg.id, {
        content: [{ type: "text", text: JSON.stringify({ error: err.message, ...(err.code ? { code: err.code } : {}) }, null, 2) }],
        isError: true,
      });
    }
  }

  if (hasId) return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  return null;
}

/**
 * Stop every live worker synchronously-ish on server exit and record why, so
 * no job is left looking "running" after its process is gone.
 */
function stopAllWorkers(reason) {
  for (const entry of live.values()) {
    if (entry.terminal) continue;
    entry.terminal = true;
    try {
      entry.session.conn.kill();
    } catch {}
    try {
      upsertJob(entry.cwd, { id: entry.jobId, status: "failed", completedAt: new Date().toISOString(), errorMessage: reason, workerPid: null });
    } catch {}
  }
}

async function main() {
  setProgressNotifier(writeMessage);
  setLogSink(writeMessage);
  emitLog("info", `copilot delegation server started (pid ${process.pid}, node ${process.version})`, { force: true });
  // Hygiene sweep shortly after boot, then hourly: TTL-based disk cleanup
  // (stale state dirs, orphaned job files, consumed reports).
  const hygieneTimer = setInterval(() => runHygieneSweep().catch(() => {}), 60 * 60 * 1000);
  hygieneTimer.unref?.();
  setTimeout(() => runHygieneSweep().catch(() => {}), 4000).unref();

  const inflight = new Set();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      writeMessage(rpcError(null, -32700, "Parse error"));
      return;
    }
    const pending = handleRpcMessage(msg)
      .then((response) => {
        if (response) writeMessage(response);
      })
      .catch((err) => {
        if (msg.id !== undefined) writeMessage(rpcError(msg.id, -32603, err.message));
      })
      .finally(() => inflight.delete(pending));
    inflight.add(pending);
  });

  const shutdown = (reason) => () => {
    stopAllWorkers(reason);
    activitySink.flush();
    process.exit(0);
  };
  // A client may half-close stdin and still read stdout: answer what is in
  // flight (bounded, so a long `wait` cannot keep orphaned workers alive),
  // then stop the workers — they would otherwise outlive their supervisor.
  rl.on("close", () => {
    const done = shutdown("worker stopped: the MCP server's client disconnected");
    const timer = setTimeout(done, 10_000);
    Promise.allSettled([...inflight]).then(() => {
      clearTimeout(timer);
      done();
    });
  });
  process.on("SIGINT", shutdown("worker stopped: the MCP server was interrupted"));
  process.on("SIGTERM", shutdown("worker stopped: the MCP server was terminated"));
}

// Direct-invocation guard. fileURLToPath is required for Windows: the naive
// `new URL(import.meta.url).pathname` yields "/C:/..." which never equals a
// resolved argv[1], so the server would silently start no stdio loop there.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main();
}

export { REPORTS_DIR };
