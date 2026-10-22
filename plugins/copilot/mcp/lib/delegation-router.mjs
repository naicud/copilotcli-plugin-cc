// Autonomous delegation-routing classifier.
// Pure heuristics over a Claude Code subagent-spawn tool input (`Task`, named
// `Agent` in newer releases) used by the PreToolUse delegation-router hook to
// decide whether the request is a strong candidate for Copilot delegation.
// Zero dependencies, fully deterministic.
//
// Keyword lists, the routing threshold and the long-prompt cutoff are all
// configurable through the optional `routing` section of config/models.json:
//   "routing": {
//     "heavy":   ["build", "test", ...],
//     "review":  ["review", "audit", ...],
//     "light":   ["explore", "find", ...],
//     "threshold": 3,
//     "longPromptChars": 1200
//   }
// User words are MERGED over the defaults; invalid entries are ignored.

const DEFAULT_HEAVY = ["build", "builds", "test", "tests", "testing", "lint", "typecheck", "tsc", "compile", "bundle", "minify", "refactor", "refactoring", "migrate", "migration", "benchmark", "regression",
  // English delegation intent — the words a user types when they want work
  // handed to subagents/Copilot rather than done inline.
  "delegate", "delegates", "delegation", "subagent", "subagents", "worker", "workers", "parallel", "parallelize", "background task", "background tasks", "fan out", "fanout",
  // Italian equivalents (same intent, matched case-insensitively).
  "delega", "dellega", "delegare", "subagente", "subagenti", "parallelizza", "parallelizzare", "in parallelo", "in background", "rifattorizza", "rifattorizzazione", "migrare"];

const DEFAULT_REVIEW = ["review", "audit", "adversarial", "verify", "qa",
  // Italian review/verify intent.
  "revisione", "revisiona", "controlla", "verifica approfondita"];
const DEFAULT_LIGHT = ["explore", "find", "locate", "search", "lookup", "read", "summary", "summarize", "quick", "list files",
  // Italian quick-look intent — keep these LOCAL.
  "esplora", "esplorare", "cerca", "trova", "leggi", "guarda", "veloce", "rapido", "sommario", "riassumi", "rispondi"];

function escapeRegex(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildWordPattern(words) {
  const clean = [...new Set(words.filter((w) => typeof w === "string" && w.trim()))].map(escapeRegex);
  if (clean.length === 0) return null;
  return new RegExp(`\\b(${clean.join("|")})\\b`, "i");
}

function normalizeRouting(routing = {}) {
  const r = routing && typeof routing === "object" ? routing : {};
  return {
    heavy: buildWordPattern([...DEFAULT_HEAVY, ...(Array.isArray(r.heavy) ? r.heavy : [])]),
    review: buildWordPattern([...DEFAULT_REVIEW, ...(Array.isArray(r.review) ? r.review : [])]),
    light: buildWordPattern([...DEFAULT_LIGHT, ...(Array.isArray(r.light) ? r.light : [])]),
    threshold: Number.isInteger(r.threshold) && r.threshold > 0 ? r.threshold : 3,
    longPromptChars: Number.isInteger(r.longPromptChars) && r.longPromptChars > 0 ? r.longPromptChars : 1200,
  };
}

/**
 * Decide whether a Task-tool invocation should be routed to Copilot.
 * @param {{description?: string, prompt?: string, subagent_type?: string}} toolInput
 * @param {object} [routing] - optional config/models.json `routing` section
 * @returns {{route: boolean, score: number, reason: string}}
 */
export function classifyDelegation(toolInput = {}, routing = {}) {
  const cfg = normalizeRouting(routing);
  const text = `${toolInput.description ?? ""} ${toolInput.prompt ?? ""}`;
  if (!text.trim()) {
    return { route: false, score: 0, reason: "empty task description" };
  }

  let score = 0;
  const signals = [];
  for (const kind of ["heavy", "review"]) {
    const weight = kind === "heavy" ? 2 : 2;
    for (const match of text.matchAll(new RegExp(cfg[kind].source, "gi"))) {
      score += weight;
      signals.push(match[0].toLowerCase());
    }
  }
  if (cfg.light) {
    for (const _match of text.matchAll(new RegExp(cfg.light.source, "gi"))) {
      score -= 1;
    }
  }
  if (text.length > cfg.longPromptChars) {
    score += 1;
    signals.push("long-prompt");
  }
  if (typeof toolInput.subagent_type === "string" && /implement|general|worker/i.test(toolInput.subagent_type)) {
    score += 1;
    signals.push("generalist-agent");
  }

  const route = score >= cfg.threshold;
  return {
    route,
    score,
    reason: route
      ? `heavy-workload signals: ${[...new Set(signals)].join(", ") || "scope"} (score ${score})`
      : "not clearly delegation-worthy",
  };
}

/** Names Claude Code has used for its subagent-spawn tool. */
export const SUBAGENT_TOOL_NAMES = ["Task", "Agent"];

/**
 * Flatten subagent-spawn arguments into the shape {@link classifyDelegation}
 * reads. `description`/`prompt`/`subagent_type` are Claude Code's names; a few
 * synonyms are accepted so a renamed field degrades to "not routed" instead
 * of throwing.
 * @param {Record<string, unknown>} toolInput
 * @returns {{description: string, prompt: string, subagent_type: string}}
 */
export function normalizeSubagentInput(toolInput = {}) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const str = (...keys) => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return "";
  };
  return {
    description: str("description", "title", "name", "summary"),
    prompt: str("prompt", "task", "instructions", "input", "message"),
    subagent_type: str("subagent_type", "agent_type", "role", "agent"),
  };
}
