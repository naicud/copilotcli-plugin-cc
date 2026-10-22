// Pure edits of config/models.json for the /copilot:model wizard.
// Every operation returns { ok, config } with a NEW object (the input is never
// mutated) or { ok: false, code, reason }; the caller validates and writes.

import { EFFORT_LEVELS } from "./catalog.mjs";

const TIERS = ["0", "1", "2", "3"];

function clone(config) {
  return JSON.parse(JSON.stringify(config ?? {}));
}

function bad(code, reason) {
  return { ok: false, code, reason };
}

/**
 * Structural problems in a models config, as human-readable strings.
 * @param {object} config
 * @returns {string[]}
 */
export function validateModelConfig(config) {
  const problems = [];
  if (!config || typeof config !== "object") return ["config must be a JSON object"];
  const tiers = config.tiers ?? {};
  if (typeof tiers !== "object" || Array.isArray(tiers)) problems.push("tiers must be an object keyed by 0-3");
  const seen = new Map();
  for (const [tier, def] of Object.entries(tiers)) {
    if (!TIERS.includes(tier)) problems.push(`tiers.${tier}: tier keys must be 0-3`);
    if (!Array.isArray(def?.models)) {
      problems.push(`tiers.${tier}.models must be an array of model ids`);
      continue;
    }
    for (const id of def.models) {
      if (typeof id !== "string" || !id.trim()) problems.push(`tiers.${tier}.models contains a non-string entry`);
      else if (seen.has(id)) problems.push(`model "${id}" is listed in both tier ${seen.get(id)} and tier ${tier}`);
      else seen.set(id, tier);
    }
  }
  const defaults = config.defaults ?? {};
  if (defaults.tier != null && !TIERS.includes(String(defaults.tier))) problems.push("defaults.tier must be 0-3");
  if (defaults.model != null && typeof defaults.model !== "string") problems.push("defaults.model must be a model id string");
  const policy = config.effortPolicy ?? {};
  const checkEffort = (label, value) => {
    if (value != null && !EFFORT_LEVELS.includes(value)) problems.push(`${label} must be one of ${EFFORT_LEVELS.join("|")}`);
  };
  checkEffort("effortPolicy.default", policy.default);
  for (const [k, v] of Object.entries(policy.perTier ?? {})) checkEffort(`effortPolicy.perTier.${k}`, v);
  for (const [k, v] of Object.entries(policy.perModel ?? {})) checkEffort(`effortPolicy.perModel.${k}`, v);
  for (const e of config.excluded ?? []) {
    const id = typeof e === "string" ? e : e?.id;
    if (typeof id !== "string" || !id) problems.push("excluded entries must be ids or {id, reason}");
  }
  if (typeof config.contract !== "string" || !config.contract.includes("${reportPath}")) {
    problems.push("contract must be a string that mentions ${reportPath}");
  }
  return problems;
}

/**
 * Put a model into a tier (at the front of its preference list), removing it
 * from any other tier.
 * @param {object} config
 * @param {{ id: string, tier: number|string }} args
 */
export function setModelTier(config, { id, tier }) {
  if (typeof id !== "string" || !id.trim()) return bad("MODEL_ID_REQUIRED", "model id required");
  const key = String(tier);
  if (!TIERS.includes(key)) return bad("TIER_INVALID", "tier must be 0-3");
  const next = clone(config);
  next.tiers = next.tiers ?? {};
  for (const def of Object.values(next.tiers)) {
    if (Array.isArray(def?.models)) def.models = def.models.filter((m) => m !== id);
  }
  next.tiers[key] = next.tiers[key] ?? { models: [] };
  next.tiers[key].models = [id, ...(next.tiers[key].models ?? [])];
  return { ok: true, config: next };
}

/**
 * Make a model the default for delegations without an explicit model/tier.
 * Passing null clears it (the default tier applies again).
 * @param {object} config
 * @param {{ id: string|null }} args
 */
export function setDefaultModel(config, { id }) {
  const next = clone(config);
  next.defaults = next.defaults ?? {};
  if (id == null || id === "") delete next.defaults.model;
  else next.defaults.model = id;
  return { ok: true, config: next };
}

/**
 * Exclude a model from selection, or include it again.
 * @param {object} config
 * @param {{ id: string, exclude: boolean, reason?: string }} args
 */
export function setExcluded(config, { id, exclude, reason }) {
  if (typeof id !== "string" || !id.trim()) return bad("MODEL_ID_REQUIRED", "model id required");
  const next = clone(config);
  const rest = (next.excluded ?? []).filter((e) => (typeof e === "string" ? e : e?.id) !== id);
  next.excluded = exclude ? [...rest, { id, reason: reason || "excluded with /copilot:model" }] : rest;
  if (exclude && next.defaults?.model === id) delete next.defaults.model;
  return { ok: true, config: next };
}

/**
 * Set the reasoning effort for a scope.
 * @param {object} config
 * @param {{ scope: { kind: "global" } | { kind: "tier", tier: number } | { kind: "model", id: string }, level: string }} args
 *   level "off" clears the scope's entry
 */
export function setEffort(config, { scope, level }) {
  if (level !== "off" && !EFFORT_LEVELS.includes(level)) return bad("EFFORT_INVALID", `effort must be one of ${[...EFFORT_LEVELS, "off"].join("|")}`);
  const next = clone(config);
  next.effortPolicy = next.effortPolicy ?? {};
  const policy = next.effortPolicy;
  const assign = (obj, key) => {
    if (level === "off") delete obj[key];
    else obj[key] = level;
  };
  if (scope?.kind === "global") assign(policy, "default");
  else if (scope?.kind === "tier") {
    if (!TIERS.includes(String(scope.tier))) return bad("TIER_INVALID", "tier must be 0-3");
    policy.perTier = policy.perTier ?? {};
    assign(policy.perTier, String(scope.tier));
  } else if (scope?.kind === "model" && scope.id) {
    policy.perModel = policy.perModel ?? {};
    assign(policy.perModel, scope.id);
  } else {
    return bad("SCOPE_INVALID", "scope must be global | tier:<N> | model:<id>");
  }
  return { ok: true, config: next };
}

/**
 * Human-readable before → after lines for the fields the wizard edits.
 * @param {object} before
 * @param {object} after
 * @returns {string[]}
 */
export function describeChanges(before, after) {
  const lines = [];
  const show = (v) => (v === undefined ? "(unset)" : JSON.stringify(v));
  const compare = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) lines.push(`${label}: ${show(a)} → ${show(b)}`);
  };
  compare("defaults", before?.defaults, after?.defaults);
  for (const tier of TIERS) compare(`tiers.${tier}.models`, before?.tiers?.[tier]?.models, after?.tiers?.[tier]?.models);
  compare("excluded", before?.excluded, after?.excluded);
  compare("effortPolicy", before?.effortPolicy, after?.effortPolicy);
  return lines.length > 0 ? lines : ["(no change)"];
}
