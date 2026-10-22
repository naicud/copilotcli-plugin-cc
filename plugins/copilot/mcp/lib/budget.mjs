// Budget accounting and enforcement for Copilot delegations.
//
// Copilot bills in AI credits (and counts premium requests); the CLI records
// both per session in its event log, and the delegation runtime copies them
// onto the job record when a job finishes (`aiCredits`, `premiumRequests`).
// Spend is what was consumed, so every finished job counts — a failed or
// cancelled run still cost credits. Pure functions over data — no I/O.

/**
 * Aggregate spend over job records, bucketed by UTC day of `createdAt`.
 * @param {Array<{ createdAt?: string, aiCredits?: unknown, premiumRequests?: unknown }>|null|undefined} jobs
 * @param {{ now?: Date }} [opts] - injectable clock for tests
 * @returns {{ credits: { total: number, today: number, byDay: Record<string, number> }, premiumRequests: { total: number, today: number }, byModel: Record<string, number> }}
 */
export function computeSpend(jobs, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const todayKey = utcDay(now.toISOString());
  const byDay = {};
  const byModel = {};
  let total = 0;
  let today = 0;
  let prTotal = 0;
  let prToday = 0;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const key = utcDay(job?.createdAt);
    if (!key) continue;
    const credits = finite(job.aiCredits);
    const requests = finite(job.premiumRequests);
    if (credits === 0 && requests === 0) continue;
    byDay[key] = round6((byDay[key] ?? 0) + credits);
    total += credits;
    prTotal += requests;
    if (key === todayKey) {
      today += credits;
      prToday += requests;
    }
    const model = typeof job.model === "string" && job.model ? job.model : "unknown";
    byModel[model] = round6((byModel[model] ?? 0) + credits);
  }
  return {
    credits: { total: round6(total), today: round6(today), byDay },
    premiumRequests: { total: round6(prTotal), today: round6(prToday) },
    byModel,
  };
}

/**
 * Check today's spend against the configured daily caps before a new
 * delegation starts:
 *   "budget": { "maxDailyCredits": 50, "maxDailyPremiumRequests": 100 }
 * Absent or null limits are not enforced.
 * @param {object|null|undefined} config - parsed models.json
 * @param {object[]} jobs - persisted job records
 * @param {{ now?: Date }} [opts]
 * @returns {{ ok: true } | { ok: false, code: "BUDGET_DAILY_CREDITS"|"BUDGET_DAILY_REQUESTS", reason: string }}
 */
export function checkBudget(config, jobs, opts = {}) {
  const budget = config?.budget;
  if (!budget || typeof budget !== "object") return { ok: true };
  const maxCredits = finiteOrUndefined(budget.maxDailyCredits);
  const maxRequests = finiteOrUndefined(budget.maxDailyPremiumRequests);
  if (maxCredits === undefined && maxRequests === undefined) return { ok: true };
  const spend = computeSpend(jobs, opts);
  if (maxCredits !== undefined && spend.credits.today >= maxCredits) {
    return {
      ok: false,
      code: "BUDGET_DAILY_CREDITS",
      reason: `today's delegations used ${spend.credits.today} AI credits, at or over budget.maxDailyCredits ${maxCredits}`,
    };
  }
  if (maxRequests !== undefined && spend.premiumRequests.today >= maxRequests) {
    return {
      ok: false,
      code: "BUDGET_DAILY_REQUESTS",
      reason: `today's delegations used ${spend.premiumRequests.today} premium requests, at or over budget.maxDailyPremiumRequests ${maxRequests}`,
    };
  }
  return { ok: true };
}

/**
 * Display-ready spend vs limits for the models tool and /copilot:cost.
 * @param {object|null|undefined} config
 * @param {object[]} jobs
 * @param {{ now?: Date }} [opts]
 */
export function summarizeBudget(config, jobs, opts = {}) {
  const budget = config?.budget && typeof config.budget === "object" ? config.budget : {};
  const maxDailyCredits = finiteOrUndefined(budget.maxDailyCredits) ?? null;
  const maxDailyPremiumRequests = finiteOrUndefined(budget.maxDailyPremiumRequests) ?? null;
  const spend = computeSpend(jobs, opts);
  return {
    spend,
    limits: { maxDailyCredits, maxDailyPremiumRequests },
    remaining: {
      dailyCredits: maxDailyCredits === null ? null : Math.max(0, round6(maxDailyCredits - spend.credits.today)),
      dailyPremiumRequests:
        maxDailyPremiumRequests === null ? null : Math.max(0, round6(maxDailyPremiumRequests - spend.premiumRequests.today)),
    },
  };
}

function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

function utcDay(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function finiteOrUndefined(v) {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
