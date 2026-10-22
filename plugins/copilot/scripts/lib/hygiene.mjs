// Hygiene reaper for the Copilot plugin: guarantees the plugin never litters
// the user's machine. Three leak classes are cleaned, each with its own TTL:
//
//   1. Whole per-workspace state dirs (<stateBase>/<hash>/) untouched beyond
//      the state TTL and without any live worker -> removed.
//   2. Orphaned per-job files (jobs/<id>.log|.json whose id no longer appears
//      in state.json after MAX_JOBS pruning, crash leftovers *.tmp.*) older
//      than the state TTL -> removed individually; active dirs survive.
//   3. Report files in KNOWN delegated workspaces (paths taken exclusively from
//      our own state.json records) older than the report TTL while no delegate
//      job there is still running -> removed. Only <workspace>/.cp-reports/*.md
//      is ever considered, nothing else.
//
// Safety rails: the sweep refuses to run against "/" or the home directory,
// live pids freeze their workspace dir, fresh files are never touched, and
// every failure degrades to a recorded error instead of throwing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateBase } from "./state.mjs";
import { isProcessAlive } from "./process-identity.mjs";

/** Per-job report directory inside a workspace (mirrors mcp/lib/worker-prompt.mjs). */
const REPORTS_DIR = ".cp-reports";

/** Default TTL for whole workspace state dirs and orphaned job files: 14 days. */
export const DEFAULT_STATE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Default TTL for consumed report files: 7 days. */
export const DEFAULT_REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Temp workspaces created by dev/demo/e2e tooling under os.tmpdir(). */
const TMP_WORKSPACE_RE = /^cp-(?:e2e|demo|bench)[a-z-]*-/;

/**
 * State TTL from env (CP_STATE_TTL_DAYS). Null disables the sweep.
 * @returns {number|null}
 */
export function stateTtlMsFromEnv() {
  const days = Number.parseInt(process.env.CP_STATE_TTL_DAYS ?? "", 10);
  if (Number.isFinite(days) && days <= 0) return null;
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : DEFAULT_STATE_TTL_MS;
}

/**
 * Report TTL from env (CP_REPORT_TTL_DAYS). Null disables report cleanup.
 * @returns {number|null}
 */
export function reportTtlMsFromEnv() {
  const days = Number.parseInt(process.env.CP_REPORT_TTL_DAYS ?? "", 10);
  if (Number.isFinite(days) && days <= 0) return null;
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : DEFAULT_REPORT_TTL_MS;
}

function mtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Newest mtime among a directory's immediate children (0 when absent).
 * @param {string} dir
 */
function newestChildMtime(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let newest = 0;
  for (const e of entries) {
    const m = mtimeMs(path.join(dir, e));
    if (m > newest) newest = m;
  }
  return newest;
}

/**
 * Worker pids of running jobs that are still alive.
 * @param {object[]} jobs
 * @param {(pid: number) => boolean} isAlive
 * @returns {number[]}
 */
function liveWorkerPids(jobs, isAlive) {
  return jobs
    .filter((j) => j?.status === "running" && Number.isInteger(j.workerPid))
    .map((j) => j.workerPid)
    .filter((pid) => isAlive(pid));
}

/**
 * Delete a file best-effort; returns true when it is actually gone after.
 * @param {string} file
 */
function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
    return !fs.existsSync(file);
  } catch {
    return false;
  }
}

/**
 * Sweep the plugin state base (all workspaces) plus every report file we
 * know about. Pure filesystem work, no network. See module header for rules.
 * @param {object} [opts]
 * @param {string} [opts.baseDir] - overrides stateBase() (tests pass sandboxes)
 * @param {Date|number} [opts.now] - reference time (tests inject clocks)
 * @param {number} [opts.stateTtlMs] - explicit TTL override
 * @param {number} [opts.reportTtlMs] - explicit TTL override (null disables)
 * @param {(pid: number) => boolean} [opts.isAlive] - liveness probe injection
 * @param {boolean} [opts.dryRun] - count what WOULD be removed, touch nothing
 * @returns {{ scanned: number, removedDirs: string[], removedJobFiles: string[],
 *             removedTmpFiles: string[], removedReports: string[], keptDirs: number, errors: string[] }}
 */
export function sweepStateDirs(opts = {}) {
  const result = {
    scanned: 0,
    removedDirs: [],
    removedJobFiles: [],
    removedTmpFiles: [],
    removedReports: [],
    keptDirs: 0,
    errors: [],
  };
  const base = opts.baseDir ?? stateBase();
  const nowTs = opts.now instanceof Date ? opts.now.getTime() : typeof opts.now === "number" ? opts.now : Date.now();
  const stateTtl = typeof opts.stateTtlMs === "number" ? opts.stateTtlMs : stateTtlMsFromEnv();
  const reportTtl = opts.reportTtlMs === undefined ? reportTtlMsFromEnv() : opts.reportTtlMs;
  const isAlive = typeof opts.isAlive === "function" ? opts.isAlive : isProcessAlive;

  if (stateTtl === null || typeof base !== "string" || !path.isAbsolute(base)) return result;
  // Refuse dangerous roots: sweeping / or the home tree is never intended.
  const resolvedBase = path.resolve(base);
  if (resolvedBase === path.parse(resolvedBase).root || resolvedBase === path.resolve(os.homedir())) {
    result.errors.push(`refusing to sweep unsafe root ${resolvedBase}`);
    return result;
  }

  // ---- rule 0: crash leftovers at the base level (activity-buffer.json.tmp.*) ----
  let baseEntries = [];
  try {
    baseEntries = fs.readdirSync(base);
  } catch {}
  for (const f of baseEntries) {
    if (!/\.tmp\./.test(f)) continue;
    const file = path.join(base, f);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    if (nowTs - mtimeMs(file) > stateTtl) {
      if (opts.dryRun || removeFile(file)) result.removedTmpFiles.push(f);
    }
  }

  let hashes = [];
  try {
    hashes = fs.readdirSync(base);
  } catch {
    return result; // no state base yet: nothing to clean
  }

  /** @type {Map<string, object[]>} workspace cwd -> its job records */
  const workspaceJobs = new Map();

  for (const h of hashes) {
    const hashDir = path.join(base, h);
    let stat;
    try {
      stat = fs.statSync(hashDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue; // activity-buffer.json etc. live at base level

    result.scanned += 1;
    let state = null;
    try {
      state = JSON.parse(fs.readFileSync(path.join(hashDir, "state.json"), "utf8"));
    } catch {}
    const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
    for (const job of jobs) {
      if (typeof job?.directory === "string" && path.isAbsolute(job.directory)) {
        const list = workspaceJobs.get(job.directory) ?? [];
        list.push(job);
        workspaceJobs.set(job.directory, list);
      }
    }

    const pids = liveWorkerPids(jobs, isAlive);

    // ---- rule 1: whole-dir removal -----------------------------------------
    const newest =
      Math.max(
        mtimeMs(path.join(hashDir, "state.json")),
        newestChildMtime(path.join(hashDir, "jobs")),
        newestChildMtime(hashDir)
      ) || mtimeMs(hashDir);
    if (pids.length === 0 && nowTs - newest > stateTtl) {
      try {
        if (!opts.dryRun) fs.rmSync(hashDir, { recursive: true, force: true });
        result.removedDirs.push(h);
      } catch (err) {
        result.errors.push(`${h}: ${err?.message ?? String(err)}`);
      }
      continue;
    }
    result.keptDirs += 1;

    // ---- rule 2: per-file pruning inside live/young dirs --------------------
    const cutoff = nowTs - stateTtl;
    const jobsDir = path.join(hashDir, "jobs");
    let files = [];
    try {
      files = fs.readdirSync(jobsDir);
    } catch {
      files = [];
    }
    const referenced = new Set(jobs.map((j) => String(j.id)));
    for (const f of files) {
      const file = path.join(jobsDir, f);
      // Crash leftovers from atomic writes always go once past the TTL.
      if (/\.tmp\./.test(f)) {
        if (mtimeMs(file) > 0 && nowTs - mtimeMs(file) > stateTtl) {
          if (removeFile(file) || opts.dryRun) result.removedTmpFiles.push(f);
        }
        continue;
      }
      const m = /^(.+)\.(log|json)$/.exec(f);
      if (!m) continue;
      if (referenced.has(m[1])) continue; // still bookkeeping-relevant
      if (nowTs - mtimeMs(file) <= stateTtl) continue; // too fresh, could race a spawn
      if (removeFile(file) || opts.dryRun) result.removedJobFiles.push(f);
    }
    let entries = [];
    try {
      entries = fs.readdirSync(hashDir);
    } catch {}
    for (const f of entries) {
      if (!/\.tmp\./.test(f)) continue;
      const file = path.join(hashDir, f);
      if (nowTs - mtimeMs(file) > stateTtl) {
        if (opts.dryRun || removeFile(file)) result.removedTmpFiles.push(`${h}/${f}`);
      }
    }
  }

  // ---- rule 3: report reaper over KNOWN workspaces only ---------------------
  if (reportTtl !== null) {
    for (const [wsPath, wsJobs] of workspaceJobs) {
      if (wsJobs.some((j) => j.status === "running")) continue; // never under live work
      const candidates = [];
      let jobReports = [];
      try {
        jobReports = fs.readdirSync(path.join(wsPath, REPORTS_DIR));
      } catch {}
      for (const f of jobReports) {
        if (f.endsWith(".md")) candidates.push(path.join(wsPath, REPORTS_DIR, f));
      }
      for (const report of candidates) {
        let st;
        try {
          st = fs.statSync(report);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        if (nowTs - st.mtimeMs <= reportTtl) continue;
        try {
          if (!opts.dryRun) fs.rmSync(report, { force: true });
          result.removedReports.push(report);
        } catch (err) {
          result.errors.push(`${report}: ${err?.message ?? String(err)}`);
        }
      }
      // Drop the reports dir itself once empty (never in dry runs).
      const reportsDir = path.join(wsPath, REPORTS_DIR);
      try {
        if (
          !opts.dryRun &&
          fs.existsSync(reportsDir) &&
          fs.readdirSync(reportsDir).length === 0
        ) {
          fs.rmdirSync(reportsDir);
        }
      } catch {}
    }
  }

  // ---- rule 4: abandoned dev/e2e/demo temp workspaces in os.tmpdir() --------
  const tmpRoot = opts.tmpDir ?? os.tmpdir();
  let tmpEntries = [];
  try {
    tmpEntries = fs.readdirSync(tmpRoot);
  } catch {}
  for (const name of tmpEntries) {
    if (!TMP_WORKSPACE_RE.test(name)) continue;
    const dir = path.join(tmpRoot, name);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (nowTs - Math.max(st.mtimeMs, newestChildMtime(dir)) <= stateTtl) continue;
    try {
      if (!opts.dryRun) fs.rmSync(dir, { recursive: true, force: true });
      result.removedDirs.push(name);
    } catch (err) {
      result.errors.push(`${name}: ${err?.message ?? String(err)}`);
    }
  }

  return result;
}
