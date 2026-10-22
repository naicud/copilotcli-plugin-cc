// Failure classification and escalation suggestions.
//
// When a delegated turn fails (quota or rate limit, auth, upstream outage, a
// worker that died), `wait` attaches an `escalation` object so the supervisor
// can re-delegate on another model instead of guessing. Pure functions over
// data — no I/O.

import { nextTierModel } from "./catalog.mjs";

/**
 * Classify a turn error into a retryable kind.
 * @param {{ name?: string, message?: string, rpcCode?: number }|null|undefined} error
 * @returns {{ kind: "none"|"auth"|"rate"|"server"|"worker"|"abort"|"unknown", retryable: boolean }}
 */
export function classifyTurnError(error) {
  if (!error) return { kind: "none", retryable: false };
  const text = `${error.name ?? ""} ${error.message ?? ""}`;
  if (/cancel|abort/i.test(text)) return { kind: "abort", retryable: false };
  if (/rate.?limit|too many requests|\b429\b|quota|exceeded|credits?/i.test(text)) return { kind: "rate", retryable: true };
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|not logged in|login|authenticat/i.test(text)) return { kind: "auth", retryable: false };
  if (/\b5\d\d\b|unavailable|overloaded|timed? ?out|ECONNRESET|socket hang up/i.test(text)) return { kind: "server", retryable: true };
  if (/ACP_EXITED|process exited|not running/i.test(text)) return { kind: "worker", retryable: true };
  return { kind: "unknown", retryable: false };
}

/**
 * Escalation suggestion attached to a failed `wait` result.
 * @param {object|null|undefined} error - turn error
 * @param {object} config - parsed models.json
 * @param {object[]} catalogModels - buildCatalog().models
 * @param {string|null|undefined} modelId - model that failed
 * @returns {{ kind: string, retryable: boolean, suggestModel?: string, reason?: string }}
 */
export function buildEscalation(error, config, catalogModels, modelId) {
  const base = classifyTurnError(error);
  if (!base.retryable) return base;
  // Rate/quota failures are model-specific: move up a tier. A dead worker or
  // a transient upstream error is worth one more try on the same model.
  const next = base.kind === "rate" ? nextTierModel(catalogModels ?? [], config, modelId ?? null) : null;
  return {
    ...base,
    ...(next ? { suggestModel: next.id } : modelId ? { suggestModel: modelId } : {}),
    reason: `${base.kind} failure on ${modelId ?? "unknown model"}`,
  };
}
