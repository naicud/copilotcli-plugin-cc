// In-memory activity buffer for delegated sessions: reasoning, assistant
// output, tool-call transitions, permission decisions and lifecycle notes,
// one line each, per job. Nothing touches disk except a small snapshot that
// lets `logs` answer after an MCP server restart, plus an opt-in per-job file
// mirror (CP_ACTIVITY_LOG=1) for following a job from a terminal.
//
// ACP streams assistant and reasoning text in small chunks; consecutive
// chunks of the same kind are coalesced into one line that is flushed when
// the kind changes, a newline arrives, or the line grows long.

import fs from "node:fs";
import path from "node:path";
import { appendLine } from "../../scripts/lib/fs.mjs";
import { jobLogPath, stateBase } from "../../scripts/lib/state.mjs";

const MAX_LINES_PER_JOB = 300;
const MAX_LINE_CHARS = 600;
const MAX_PERSISTED_JOBS = 100;
const FLUSH_INTERVAL_MS = 10_000;
const STREAM_KINDS = new Set(["assistant", "reasoning"]);

function bufferFile() {
  return path.join(stateBase(), "activity-buffer.json");
}

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function clean(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, MAX_LINE_CHARS);
}

/**
 * Create the activity sink shared by every session of one server process.
 */
export function createActivitySink() {
  /** @type {Map<string, string[]>} key (jobId AND sessionID) -> shared lines array */
  const buffers = new Map();
  /** @type {Map<string, { cwd: string, jobId: string }>} sessionID/jobId -> owner */
  const owners = new Map();
  /** @type {Map<string, { kind: string, text: string }>} jobId -> open streamed line */
  const open = new Map();
  let loadedFromDisk = false;
  let dirty = false;
  let flushTimer = null;

  function persist() {
    for (const jobId of [...open.keys()]) closeStream(jobId);
    if (!dirty) return;
    dirty = false;
    try {
      const jobs = {};
      let count = 0;
      for (const [key, arr] of buffers) {
        if (!owners.get(key) || owners.get(key).jobId !== key || arr.length === 0) continue;
        jobs[key] = arr.slice(-MAX_LINES_PER_JOB);
        if (++count >= MAX_PERSISTED_JOBS) break;
      }
      fs.mkdirSync(stateBase(), { recursive: true });
      const tmp = `${bufferFile()}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), jobs }));
      fs.renameSync(tmp, bufferFile());
    } catch {
      // best-effort only
    }
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setInterval(persist, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }

  function loadOnce() {
    if (loadedFromDisk) return;
    loadedFromDisk = true;
    try {
      const data = JSON.parse(fs.readFileSync(bufferFile(), "utf8"));
      for (const [jobId, lines] of Object.entries(data.jobs ?? {})) {
        if (buffers.has(jobId)) continue;
        buffers.set(jobId, Array.isArray(lines) ? lines.slice(-MAX_LINES_PER_JOB) : []);
      }
    } catch {
      // first run or unreadable snapshot: start empty
    }
  }

  process.on("exit", () => {
    try {
      persist();
    } catch {}
  });

  function linesFor(jobId) {
    let arr = buffers.get(jobId);
    if (!arr) {
      arr = [];
      buffers.set(jobId, arr);
    }
    return arr;
  }

  function writeLine(jobId, kind, text) {
    const body = clean(text);
    if (!body) return;
    const line = `[${stamp()}] [${kind}] ${body}`;
    const arr = linesFor(jobId);
    arr.push(line);
    if (arr.length > MAX_LINES_PER_JOB * 2) arr.splice(0, arr.length - MAX_LINES_PER_JOB);
    scheduleFlush();
    if (process.env.CP_ACTIVITY_LOG === "1") {
      const owner = owners.get(jobId);
      if (owner) {
        try {
          appendLine(jobLogPath(owner.cwd, jobId), line);
        } catch {}
      }
    }
  }

  function closeStream(jobId) {
    const pending = open.get(jobId);
    if (!pending) return;
    open.delete(jobId);
    writeLine(jobId, pending.kind, pending.text);
  }

  /**
   * Associate a session with its job so lines can be looked up by either id.
   * @param {string} cwd
   * @param {string} jobId
   * @param {string} [sessionID]
   */
  function bind(cwd, jobId, sessionID) {
    const owner = { cwd, jobId };
    owners.set(jobId, owner);
    const arr = linesFor(jobId);
    if (sessionID) {
      owners.set(sessionID, owner);
      buffers.set(sessionID, arr);
    }
  }

  /**
   * Record one activity item for a job. Streamed kinds are coalesced.
   * @param {string} jobId
   * @param {string} kind - assistant | reasoning | tool | permission | plan | lifecycle | error | ...
   * @param {string} text
   */
  function record(jobId, kind, text) {
    if (!jobId) return;
    try {
      if (STREAM_KINDS.has(kind)) {
        const pending = open.get(jobId);
        if (pending && pending.kind !== kind) closeStream(jobId);
        const current = open.get(jobId) ?? { kind, text: "" };
        current.text += text;
        open.set(jobId, current);
        if (current.text.includes("\n") || current.text.length >= MAX_LINE_CHARS) closeStream(jobId);
        return;
      }
      closeStream(jobId);
      writeLine(jobId, kind, text);
    } catch {
      // never break supervision
    }
  }

  /**
   * Last n lines for a jobId or sessionID. Falls back to the snapshot of a
   * previous server process when the live buffer has nothing.
   * @returns {string[]}
   */
  function tail(key, n = 80) {
    const owner = owners.get(key);
    if (owner) closeStream(owner.jobId);
    let arr = buffers.get(key);
    if (!arr || arr.length === 0) {
      loadOnce();
      arr = buffers.get(key);
    }
    if (!arr || arr.length === 0) return [];
    return arr.slice(-Math.max(1, Math.min(n, MAX_LINES_PER_JOB)));
  }

  /**
   * Compact one-line summary for MCP progress frames: latest reasoning,
   * newest tool transition and assistant tail joined with separators.
   */
  function summary(key) {
    const owner = owners.get(key);
    const live = owner ? open.get(owner.jobId) : null;
    const arr = buffers.get(key) ?? [];
    let reasoning = live?.kind === "reasoning" ? clean(live.text) : "";
    let text = live?.kind === "assistant" ? clean(live.text) : "";
    let tool = "";
    for (let i = arr.length - 1; i >= 0; i--) {
      const line = arr[i];
      const body = line.replace(/^\[[\d:.]+\] \[\w+\] /, "");
      if (!tool && line.includes("[tool]")) tool = body;
      if (!reasoning && line.includes("[reasoning]")) reasoning = body;
      if (!text && line.includes("[assistant]")) text = body;
      if (reasoning && tool && text) break;
    }
    return [reasoning && `…${reasoning.slice(-140)}`, tool, text && `${text.slice(0, 140)}…`].filter(Boolean).join(" · ");
  }

  return { bind, record, tail, summary, flush: persist };
}
