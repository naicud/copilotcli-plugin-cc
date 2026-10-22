// Locating and probing the GitHub Copilot CLI.
//
// Everything that needs to know where `copilot` lives, which version it is,
// who is logged in, or where it keeps a session's on-disk record goes through
// this module, so tests can swap the real binary for a fake ACP agent with a
// single environment variable (CP_COPILOT_BIN).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./process.mjs";

/**
 * Command + leading arguments that launch the Copilot CLI.
 *
 * CP_COPILOT_BIN overrides discovery. A `.mjs`/`.js` override runs under the
 * current node binary, which is how the test suite plugs in its fake agent.
 * On Windows an npm-installed CLI is a `.cmd` shim that cannot be spawned
 * without a shell, so it is routed through `cmd.exe /d /s /c`.
 * @returns {{ command: string, prefix: string[] }}
 */
export function resolveCopilotCommand() {
  const override = (process.env.CP_COPILOT_BIN ?? "").trim();
  if (override) {
    if (/\.(mjs|cjs|js)$/i.test(override)) return { command: process.execPath, prefix: [override] };
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(override)) {
      return { command: "cmd.exe", prefix: ["/d", "/s", "/c", override] };
    }
    return { command: override, prefix: [] };
  }
  if (process.platform === "win32") {
    return { command: "cmd.exe", prefix: ["/d", "/s", "/c", "copilot"] };
  }
  return { command: "copilot", prefix: [] };
}

/**
 * Installed Copilot CLI version (e.g. "1.0.102"), or null when the binary is
 * missing or does not answer `--version`.
 * @returns {Promise<string|null>}
 */
export async function getCopilotVersion() {
  const { command, prefix } = resolveCopilotCommand();
  const res = await runCommand(command, [...prefix, "--version"], { timeoutMs: 15_000 });
  if (res.exitCode !== 0) return null;
  const match = /(\d+\.\d+\.\d+(?:[-.][\w.]+)?)/.exec(res.stdout);
  return match ? match[1].replace(/\.$/, "") : res.stdout.trim() || null;
}

/**
 * Whether the Copilot CLI can be launched at all.
 * @returns {Promise<boolean>}
 */
export async function isCopilotInstalled() {
  return (await getCopilotVersion()) !== null;
}

/**
 * Copilot CLI configuration directory (COPILOT_HOME, else ~/.copilot).
 * @returns {string}
 */
export function copilotHome() {
  const explicit = (process.env.COPILOT_HOME ?? "").trim();
  return explicit || path.join(os.homedir(), ".copilot");
}

/** Token variables the CLI reads, in its own precedence order. */
export const TOKEN_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

/**
 * Who the CLI will authenticate as, as far as can be told without a network
 * round trip: a token variable wins (that is the CLI's own precedence), then
 * the last interactive login recorded in config.json. The file opens with
 * `//` comment lines, so those are stripped before parsing.
 * @returns {{ source: "env"|"login"|null, login: string|null, variable?: string }}
 */
export function detectAuth() {
  for (const variable of TOKEN_ENV_VARS) {
    if ((process.env[variable] ?? "").trim()) return { source: "env", login: null, variable };
  }
  try {
    const raw = fs.readFileSync(path.join(copilotHome(), "config.json"), "utf8");
    const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
    const login = json?.lastLoggedInUser?.login ?? json?.loggedInUsers?.[0]?.login ?? null;
    if (login) return { source: "login", login };
  } catch {
    // no config yet: never logged in
  }
  return { source: null, login: null };
}

/**
 * Path of the event log Copilot keeps for a session.
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionEventsPath(sessionId) {
  return path.join(copilotHome(), "session-state", sessionId, "events.jsonl");
}

/**
 * Usage accounting for a session, read from its on-disk event log. The CLI
 * appends `session.usage_checkpoint` after every turn and a final
 * `session.shutdown` with the full accounting snapshot; the newest of either
 * wins. AI credits are the billed unit (1 credit = 1e9 nano-AIU).
 * @param {string} sessionId
 * @returns {{ aiCredits: number, premiumRequests: number, linesAdded?: number, linesRemoved?: number, filesModified?: string[] }|null}
 */
export function readSessionAccounting(sessionId) {
  if (typeof sessionId !== "string" || !/^[\w-]+$/.test(sessionId)) return null;
  let lines;
  try {
    lines = fs.readFileSync(sessionEventsPath(sessionId), "utf8").split("\n");
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "session.shutdown") {
      const snap = event.data?.accountingSnapshot ?? {};
      return {
        aiCredits: nanoToCredits(snap.totalNanoAiu),
        premiumRequests: finite(snap.totalPremiumRequestCost),
        linesAdded: finite(snap.codeChanges?.linesAdded),
        linesRemoved: finite(snap.codeChanges?.linesRemoved),
        filesModified: Array.isArray(snap.codeChanges?.filesModified) ? snap.codeChanges.filesModified : [],
      };
    }
    if (event?.type === "session.usage_checkpoint") {
      return {
        aiCredits: nanoToCredits(event.data?.totalNanoAiu),
        premiumRequests: finite(event.data?.totalPremiumRequests),
      };
    }
  }
  return null;
}

/**
 * Remove the on-disk record of a session that never ran a turn. Opening a
 * session only to read the model catalog leaves an empty directory behind;
 * this deletes it, and nothing else: the id must be a plain session id and
 * the directory must hold no event log (a session that saw a prompt has one).
 * @param {string} sessionId
 * @returns {boolean} whether anything was removed
 */
export function discardEmptySession(sessionId) {
  if (typeof sessionId !== "string" || !/^[0-9a-f-]{16,64}$/i.test(sessionId)) return false;
  const root = path.join(copilotHome(), "session-state");
  const dir = path.join(root, sessionId);
  if (path.dirname(dir) !== root) return false;
  try {
    if (fs.existsSync(path.join(dir, "events.jsonl"))) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function nanoToCredits(nano) {
  const n = Number(nano);
  return Number.isFinite(n) ? Math.round(n / 1e3) / 1e6 : 0;
}

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
