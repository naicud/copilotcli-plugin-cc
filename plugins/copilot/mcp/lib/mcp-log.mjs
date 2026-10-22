// MCP logging channel for the Copilot delegation server.
//
// Claude Code's MCP tab only shows log lines the server actually sends over
// the JSON-RPC stdout channel as `notifications/message` frames (and mirrors
// stderr into its client logs). Until now the server emitted NEITHER: progress
// notifications require a caller-supplied progressToken, so a default session
// looked completely mute. This module is the single funnel for both sinks:
//
//   1. `notifications/message` frame  -> rendered in the MCP UI / logs view
//   2. `[copilot:<level>] ...` line -> process.stderr (claude --mcp-debug)
//
// Volume discipline: lifecycle + terminal transitions only; identical messages
// inside the throttle window collapse to one emission.

import process from "node:process";

/** MCP logging levels in ascending severity (spec order). */
export const LOG_LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];

const DEFAULT_MIN_LEVEL = "info";
const THROTTLE_MS = 1000;

let minLevel = DEFAULT_MIN_LEVEL;
let sink = null; // set once from main(); direct-import tests stay silent
/** @type {Map<string, number>} throttle key -> last emission ts */
const lastEmit = new Map();

/**
 * Severity index of a level name; unknown levels map to "info" severity.
 * @param {string} level
 */
function severity(level) {
  const idx = LOG_LEVELS.indexOf(level);
  return idx >= 0 ? idx : LOG_LEVELS.indexOf("info");
}

/**
 * Register the stdout writer used for notifications/message frames.
 * Called once from main(); direct-import tests leave it unset (no-op module).
 * @param {(msg: object) => void} [fn]
 */
export function setLogSink(fn) {
  sink = typeof fn === "function" ? fn : null;
}

/**
 * Apply logging/setLevel from the client. Unknown or out-of-domain values are
 * ignored (the previous floor stays active), mirroring lenient server behavior.
 * @param {string} [level]
 * @returns {string} the active minimum level after the call
 */
export function setLogLevel(level) {
  if (LOG_LEVELS.includes(level)) minLevel = level;
  return minLevel;
}

/** @returns {string} current minimum level */
export function getLogLevel() {
  return minLevel;
}

/** Test hook: reset module state between tests. */
export function resetMcpLog() {
  minLevel = DEFAULT_MIN_LEVEL;
  sink = null;
  lastEmit.clear();
}

/**
 * Emit one log line to both sinks, honoring the level floor and the throttle.
 * @param {string} level - one of LOG_LEVELS
 * @param {string} message - human-readable single line
 * @param {{ data?: any, force?: boolean }} [opts] - force bypasses the throttle
 *   for unique lifecycle events; data becomes the frame's structured payload
 * @returns {boolean} true when a frame was actually written
 */
export function emitLog(level, message, opts = {}) {
  const lvl = LOG_LEVELS.includes(level) ? level : "info";
  if (severity(lvl) < severity(minLevel)) return false;
  const key = `${lvl}:${message}`;
  const now = Date.now();
  if (!opts.force && now - (lastEmit.get(key) ?? 0) < THROTTLE_MS) return false;
  lastEmit.set(key, now);
  if (lastEmit.size > 500) lastEmit.clear();

  if (sink) {
    try {
      sink({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
          level: lvl,
          logger: "copilot",
          data: opts.data !== undefined ? opts.data : String(message),
        },
      });
    } catch {
      // a broken sink must never take the server down
    }
  }
  try {
    const extra = opts.data !== undefined && typeof opts.data !== "string" ? ` ${JSON.stringify(opts.data)}` : "";
    process.stderr.write(`[copilot:${lvl}] ${String(message)}${extra}\n`);
  } catch {}
  return true;
}
