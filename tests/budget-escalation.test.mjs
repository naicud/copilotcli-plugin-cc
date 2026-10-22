import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeSpend, checkBudget, summarizeBudget } from "../plugins/copilot/mcp/lib/budget.mjs";
import { classifyTurnError, buildEscalation } from "../plugins/copilot/mcp/lib/escalation.mjs";

const NOW = new Date("2026-10-22T12:00:00Z");
const JOBS = [
  { createdAt: "2026-10-22T08:00:00Z", status: "completed", model: "a", aiCredits: 1.5, premiumRequests: 2 },
  { createdAt: "2026-10-22T09:00:00Z", status: "failed", model: "b", aiCredits: 0.5, premiumRequests: 1 },
  { createdAt: "2026-10-21T09:00:00Z", status: "completed", model: "a", aiCredits: 3, premiumRequests: 3 },
  { createdAt: "2026-10-22T10:00:00Z", status: "running" },
  { createdAt: "not a date", aiCredits: 99 },
];

describe("budget", () => {
  it("counts every finished job's credits, failed ones included", () => {
    const spend = computeSpend(JOBS, { now: NOW });
    assert.equal(spend.credits.today, 2);
    assert.equal(spend.credits.total, 5);
    assert.equal(spend.premiumRequests.today, 3);
    assert.deepEqual(spend.credits.byDay, { "2026-10-22": 2, "2026-10-21": 3 });
    assert.deepEqual(spend.byModel, { a: 4.5, b: 0.5 });
  });

  it("enforces daily credit and premium-request caps", () => {
    assert.deepEqual(checkBudget({}, JOBS, { now: NOW }), { ok: true });
    assert.deepEqual(checkBudget({ budget: { maxDailyCredits: null } }, JOBS, { now: NOW }), { ok: true });
    assert.equal(checkBudget({ budget: { maxDailyCredits: 2 } }, JOBS, { now: NOW }).code, "BUDGET_DAILY_CREDITS");
    assert.equal(checkBudget({ budget: { maxDailyCredits: 5 } }, JOBS, { now: NOW }).ok, true);
    assert.equal(checkBudget({ budget: { maxDailyPremiumRequests: 3 } }, JOBS, { now: NOW }).code, "BUDGET_DAILY_REQUESTS");
  });

  it("summarizes remaining headroom", () => {
    const s = summarizeBudget({ budget: { maxDailyCredits: 10 } }, JOBS, { now: NOW });
    assert.equal(s.remaining.dailyCredits, 8);
    assert.equal(s.remaining.dailyPremiumRequests, null);
  });
});

describe("escalation", () => {
  it("classifies turn errors", () => {
    assert.equal(classifyTurnError(null).kind, "none");
    assert.deepEqual(classifyTurnError({ message: "session/prompt: rate limit exceeded" }), { kind: "rate", retryable: true });
    assert.deepEqual(classifyTurnError({ message: "monthly quota exceeded" }), { kind: "rate", retryable: true });
    assert.deepEqual(classifyTurnError({ message: "401 Unauthorized" }), { kind: "auth", retryable: false });
    assert.deepEqual(classifyTurnError({ message: "upstream 503 unavailable" }), { kind: "server", retryable: true });
    assert.deepEqual(classifyTurnError({ name: "ACP_EXITED", message: "copilot ACP process exited (code 1)" }), { kind: "worker", retryable: true });
    assert.deepEqual(classifyTurnError({ message: "turn cancelled" }), { kind: "abort", retryable: false });
    assert.deepEqual(classifyTurnError({ message: "weird" }), { kind: "unknown", retryable: false });
  });

  it("moves rate failures up a tier and retries the same model otherwise", () => {
    const models = [
      { id: "cheap", tier: 0 },
      { id: "std", tier: 1 },
      { id: "pro", tier: 2 },
    ];
    const config = { tiers: { 0: { models: ["cheap"] }, 1: { models: ["std"] }, 2: { models: ["pro"] } } };
    assert.equal(buildEscalation({ message: "rate limit" }, config, models, "std").suggestModel, "pro");
    assert.equal(buildEscalation({ message: "503 unavailable" }, config, models, "std").suggestModel, "std");
    assert.equal(buildEscalation({ message: "rate limit" }, config, models, "pro").suggestModel, "pro", "top of the ladder: same model again");
    assert.equal(buildEscalation({ message: "401" }, config, models, "std").retryable, false);
  });
});
