// Model catalog and selection for Copilot delegations.
//
// Two sources are merged:
//   - config/models.json: tiers (ordered model preferences per tier), the
//     effort policy, exclusions, defaults;
//   - the live catalog the Copilot CLI advertises in session/new
//     (availableModels with `copilotUsage` multiplier, price category and
//     enablement), which is what the signed-in account can actually use.
//
// The live list is cached on disk for a few hours so `models` and delegate
// resolution do not have to start a worker just to read it; every worker that
// opens a session refreshes the cache for free.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateBase } from "../../scripts/lib/state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.join(__dirname, "..", "..", "config", "models.json");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Reasoning effort levels the CLI accepts (`--reasoning-effort`). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Path of the models config. CP_MODELS_CONFIG overrides it (tests, forks).
 * @returns {string}
 */
export function configPath() {
  return process.env.CP_MODELS_CONFIG || DEFAULT_CONFIG_PATH;
}

/**
 * Read config/models.json. A missing or unreadable file yields an empty
 * config so diagnostics can still run.
 * @returns {object}
 */
export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return {};
    throw Object.assign(new Error(`config/models.json is not valid JSON: ${err.message}`), { code: "CONFIG_INVALID" });
  }
}

/**
 * Parse a `copilotUsage` multiplier ("0.33x", "1x", "15x") into a number.
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseMultiplier(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = /^\s*([\d.]+)\s*x?\s*$/i.exec(String(value ?? ""));
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize the agent's availableModels list: drop the "auto" pseudo-model,
 * de-duplicate ids, and lift the `_meta` fields we care about.
 * @param {object[]} available
 * @returns {Array<{ id: string, name: string, multiplier: number|null, priceCategory: string|null, enabled: boolean }>}
 */
export function normalizeLiveModels(available) {
  const seen = new Map();
  for (const m of Array.isArray(available) ? available : []) {
    const id = m?.modelId;
    if (typeof id !== "string" || !id || id === "auto") continue;
    if (seen.has(id)) continue;
    const meta = m._meta ?? {};
    seen.set(id, {
      id,
      name: m.name ?? id,
      multiplier: parseMultiplier(meta.copilotUsage),
      priceCategory: meta.copilotPriceCategory ?? null,
      enabled: meta.copilotEnablement == null || meta.copilotEnablement === "enabled",
    });
  }
  return [...seen.values()];
}

function cacheFile() {
  return path.join(stateBase(), "catalog-cache.json");
}

/**
 * Store a freshly observed live catalog.
 * @param {object[]} available - raw availableModels from session/new
 */
export function rememberLiveCatalog(available) {
  const models = normalizeLiveModels(available);
  if (models.length === 0) return;
  try {
    fs.mkdirSync(stateBase(), { recursive: true });
    const tmp = `${cacheFile()}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: new Date().toISOString(), models }));
    fs.renameSync(tmp, cacheFile());
  } catch {
    // best effort: the next worker will try again
  }
}

/**
 * Cached live catalog, or null when missing/stale.
 * @param {{ maxAgeMs?: number }} [opts]
 * @returns {{ fetchedAt: string, models: object[] }|null}
 */
export function readCachedCatalog({ maxAgeMs = CACHE_TTL_MS } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    const age = Date.now() - Date.parse(data.fetchedAt);
    if (!Array.isArray(data.models) || !(age >= 0) || age > maxAgeMs) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Tier a model belongs to: its position in config.tiers, else a guess from
 * its multiplier (premium > 1x is tier 3, sub-1x is tier 0, 1x splits by
 * price category).
 * @param {string} id
 * @param {object} config
 * @param {{ multiplier?: number|null, priceCategory?: string|null }} [live]
 * @returns {number}
 */
export function tierOf(id, config, live = {}) {
  for (const [tier, def] of Object.entries(config?.tiers ?? {})) {
    if ((def?.models ?? []).includes(id)) return Number(tier);
  }
  const mult = live.multiplier;
  if (Number.isFinite(mult)) {
    if (mult > 1) return 3;
    if (mult < 1) return 0;
  }
  if (live.priceCategory === "high" || live.priceCategory === "very_high") return 2;
  return 1;
}

/**
 * Merge config and live catalog into the selectable model list.
 * Without a live catalog every configured model is listed (unverified).
 * @param {object} config
 * @param {object[]|null} liveModels - normalized live models
 * @returns {{ models: object[], excluded: object[], live: boolean }}
 */
export function buildCatalog(config, liveModels) {
  const excludedIds = new Map((config?.excluded ?? []).map((e) => [typeof e === "string" ? e : e.id, e.reason ?? null]));
  const configured = new Set(Object.values(config?.tiers ?? {}).flatMap((t) => t?.models ?? []));
  const live = Array.isArray(liveModels) && liveModels.length > 0;
  const source = live
    ? liveModels
    : [...configured].map((id) => ({ id, name: id, multiplier: null, priceCategory: null, enabled: true }));
  const models = [];
  const excluded = [];
  for (const m of source) {
    if (excludedIds.has(m.id)) {
      excluded.push({ id: m.id, reason: excludedIds.get(m.id) });
      continue;
    }
    if (!m.enabled) {
      excluded.push({ id: m.id, reason: "not enabled for this Copilot account/plan" });
      continue;
    }
    models.push({
      id: m.id,
      name: m.name,
      tier: tierOf(m.id, config, m),
      multiplier: m.multiplier,
      priceCategory: m.priceCategory,
      configured: configured.has(m.id),
      ...(config?.defaults?.model === m.id ? { default: true } : {}),
    });
  }
  models.sort((a, b) => a.tier - b.tier || (a.multiplier ?? 1) - (b.multiplier ?? 1) || a.id.localeCompare(b.id));
  return { models, excluded, live };
}

/**
 * Pick the model and effort for a delegation.
 * Precedence: explicit model → explicit tier → defaults.model → defaults.tier.
 * Within a tier the configured order wins; tiers with no usable model fall
 * through to the live models classified into that tier.
 * @param {{ modelId?: string, tier?: number, effort?: string }} request
 * @param {object[]} catalogModels - buildCatalog().models
 * @param {object} config
 * @returns {{ model: object, effort: string|null, source: string, reason: string|null }}
 */
export function resolveSelection(request, catalogModels, config) {
  const byId = new Map(catalogModels.map((m) => [m.id, m]));
  let model = null;
  let source;
  let reason = null;

  if (request.modelId != null) {
    if (typeof request.modelId !== "string" || !request.modelId.trim()) {
      throw Object.assign(new Error("model must be a non-empty model id"), { code: "MODEL_INVALID" });
    }
    model = byId.get(request.modelId);
    if (!model) {
      throw Object.assign(
        new Error(`model "${request.modelId}" is not selectable (excluded, not enabled, or unknown); available: ${catalogModels.map((m) => m.id).join(", ") || "none"}`),
        { code: "MODEL_INVALID" }
      );
    }
    source = "explicit-model";
  } else {
    let tier = request.tier;
    source = "explicit-tier";
    if (tier == null) {
      if (config?.defaults?.model && byId.has(config.defaults.model)) {
        model = byId.get(config.defaults.model);
        source = "default-model";
      } else {
        tier = Number(config?.defaults?.tier ?? 1);
        source = "default-tier";
        if (config?.defaults?.model) reason = `default model "${config.defaults.model}" is not selectable; fell back to tier ${tier}`;
      }
    }
    if (!model) {
      if (!Number.isInteger(tier) || tier < 0 || tier > 3) {
        throw Object.assign(new Error(`tier must be an integer 0-3 (got ${JSON.stringify(request.tier)})`), { code: "TIER_INVALID" });
      }
      const preferred = config?.tiers?.[String(tier)]?.models ?? [];
      model = preferred.map((id) => byId.get(id)).find(Boolean) ?? catalogModels.find((m) => m.tier === tier) ?? null;
      if (!model) {
        throw Object.assign(new Error(`no selectable model in tier ${tier}; run the models tool to see what this account can use`), {
          code: "TIER_EMPTY",
        });
      }
    }
  }

  return { model, effort: resolveEffort(request.effort, model, config), source, reason };
}

/**
 * Effort for a model: explicit request ("off" = agent default), else the
 * per-model / per-tier / global policy.
 * @param {string|undefined} requested
 * @param {{ id: string, tier: number }} model
 * @param {object} config
 * @returns {string|null}
 */
export function resolveEffort(requested, model, config) {
  if (requested != null) {
    if (requested === "off") return null;
    if (!EFFORT_LEVELS.includes(requested)) {
      throw Object.assign(new Error(`effort must be one of ${[...EFFORT_LEVELS, "off"].join("|")}`), { code: "EFFORT_INVALID" });
    }
    return requested;
  }
  const policy = config?.effortPolicy ?? {};
  const picked = policy.perModel?.[model.id] ?? policy.perTier?.[String(model.tier)] ?? policy.default ?? null;
  return EFFORT_LEVELS.includes(picked) ? picked : null;
}

/**
 * Next model up the tier ladder, for escalation after a failure.
 * @param {object[]} catalogModels
 * @param {object} config
 * @param {string|null} currentId
 * @returns {object|null}
 */
export function nextTierModel(catalogModels, config, currentId) {
  const current = catalogModels.find((m) => m.id === currentId);
  const currentTier = current?.tier ?? Number(config?.defaults?.tier ?? 1);
  for (let tier = currentTier + 1; tier <= 3; tier += 1) {
    const preferred = config?.tiers?.[String(tier)]?.models ?? [];
    const hit = preferred.map((id) => catalogModels.find((m) => m.id === id)).find(Boolean) ?? catalogModels.find((m) => m.tier === tier);
    if (hit) return hit;
  }
  return null;
}

/**
 * One-line selection hint for the supervisor.
 * @param {object} config
 * @param {object[]} models
 * @returns {string}
 */
export function formatHint(config, models) {
  const lines = [];
  for (const tier of [0, 1, 2, 3]) {
    const inTier = models.filter((m) => m.tier === tier);
    if (inTier.length === 0) continue;
    const use = config?.tiers?.[String(tier)]?.use;
    lines.push(`tier ${tier}${use ? ` (${use})` : ""}: ${inTier.map((m) => `${m.id}${m.multiplier != null ? ` ${m.multiplier}x` : ""}`).join(", ")}`);
  }
  return lines.join("\n");
}
