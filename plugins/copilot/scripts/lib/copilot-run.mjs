// One-shot Copilot runs for the companion's slash commands (review,
// adversarial review, rescue tasks, the stop gate).
//
// Unlike MCP delegations nobody supervises these turns interactively, so every
// permission request is decided on the spot: read-only runs approve only
// read-only shell commands and deny writes outright; write runs approve what
// the configured deny rules do not block.

import { startCopilotSession } from "../../mcp/lib/copilot-session.mjs";
import { loadConfig, buildCatalog, readCachedCatalog, resolveSelection, rememberLiveCatalog } from "../../mcp/lib/catalog.mjs";
import { readSessionAccounting } from "./copilot-bin.mjs";

/** Shell commands a read-only run may execute without asking. */
export const READ_ONLY_SHELL = [
  "^git (status|diff|log|show|blame|rev-parse|branch|ls-files|grep)\\b",
  "^(cat|ls|rg|grep|find|head|tail|wc|stat|file|tree|pwd)\\b",
  "^sed -n\\b",
];

/**
 * Model and effort for a companion run: explicit flags win; otherwise the
 * configured default resolved against the cached live catalog. With no cache
 * yet the model is left to Copilot's own default rather than paying for a
 * catalog probe.
 * @param {{ model?: string|null, effort?: string|null }} flags
 * @returns {{ model: string|null, effort: string|null }}
 */
export function pickModel(flags = {}) {
  const config = loadConfig();
  const cached = readCachedCatalog({ maxAgeMs: Infinity });
  if (!cached) return { model: flags.model ?? config.defaults?.model ?? null, effort: flags.effort ?? config.effortPolicy?.default ?? null };
  const catalog = buildCatalog(config, cached.models);
  try {
    const sel = resolveSelection({ modelId: flags.model ?? undefined, effort: flags.effort ?? undefined }, catalog.models, config);
    return { model: sel.model.id, effort: sel.effort };
  } catch {
    return { model: flags.model ?? null, effort: flags.effort ?? null };
  }
}

/**
 * Run one prompt to completion.
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.prompt
 * @param {boolean} [opts.write] - allow file edits (task --write)
 * @param {string|null} [opts.model]
 * @param {string|null} [opts.effort]
 * @param {string|null} [opts.resumeSessionId]
 * @param {(session: object) => void} [opts.onSession] - called once the session is open
 * @param {(kind: string, text: string) => void} [opts.onActivity]
 * @param {AbortSignal} [opts.signal] - cancels the turn
 * @returns {Promise<{ sessionId: string, model: string|null, text: string, stopReason: string|null, error: object|null, usage: object|null, accounting: object|null }>}
 */
export async function runCopilotPrompt(opts) {
  const config = loadConfig();
  const permissions = config.permissions ?? {};
  const write = opts.write === true;
  const base = opts.resumeSessionId ? readSessionAccounting(opts.resumeSessionId) : null;
  const session = await startCopilotSession({
    cwd: opts.cwd,
    model: opts.model ?? null,
    effort: opts.effort ?? null,
    resumeSessionId: opts.resumeSessionId ?? null,
    allowTools: write ? [...new Set(["write", ...(permissions.allowTools ?? [])])] : [],
    denyTools: write ? permissions.denyTools ?? [] : ["write", ...(permissions.denyTools ?? [])],
    rules: () =>
      write
        ? { autoApprove: permissions.autoApprove ?? [], autoReject: permissions.autoReject ?? [] }
        : { autoApprove: READ_ONLY_SHELL, autoReject: [] },
    unmatched: write ? "approve" : "reject",
    onActivity: opts.onActivity,
  });
  rememberLiveCatalog(session.models);
  opts.onSession?.(session);

  const onAbort = () => session.cancel();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    session.prompt(opts.prompt);
    await session.settled();
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    await session.close({ graceMs: 2000 }).catch(() => {});
  }
  const turn = session.lastTurn;
  const now = readSessionAccounting(session.id);
  const accounting = now
    ? {
        aiCredits: Math.max(0, Math.round((now.aiCredits - (base?.aiCredits ?? 0)) * 1e6) / 1e6),
        premiumRequests: Math.max(0, now.premiumRequests - (base?.premiumRequests ?? 0)),
      }
    : null;
  return {
    sessionId: session.id,
    model: session.model,
    text: (turn?.assistant ?? "").trim(),
    stopReason: turn?.stopReason ?? null,
    error: turn?.error ?? null,
    usage: turn?.usage ?? null,
    accounting,
  };
}
