import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseMultiplier,
  normalizeLiveModels,
  buildCatalog,
  resolveSelection,
  resolveEffort,
  nextTierModel,
  tierOf,
} from "../plugins/copilot/mcp/lib/catalog.mjs";

const LIVE = normalizeLiveModels([
  { modelId: "auto", name: "Auto" },
  { modelId: "auto", name: "Auto", _meta: { copilotUsage: "1x" } },
  { modelId: "haiku", name: "Haiku", _meta: { copilotUsage: "0.33x", copilotEnablement: "enabled", copilotPriceCategory: "low" } },
  { modelId: "sonnet", name: "Sonnet", _meta: { copilotUsage: "1x", copilotEnablement: "enabled", copilotPriceCategory: "medium" } },
  { modelId: "astra", name: "Astra", _meta: { copilotUsage: "1x", copilotEnablement: "enabled", copilotPriceCategory: "very_high" } },
  { modelId: "opus", name: "Opus", _meta: { copilotUsage: "15x", copilotEnablement: "enabled", copilotPriceCategory: "high" } },
  { modelId: "off", name: "Off", _meta: { copilotUsage: "1x", copilotEnablement: "disabled" } },
]);

const CONFIG = {
  defaults: { tier: 1 },
  tiers: { 0: { models: ["haiku"] }, 1: { models: ["missing", "sonnet"] }, 3: { models: ["opus"] } },
  excluded: [{ id: "astra", reason: "too slow" }],
  effortPolicy: { default: "high", perTier: { 0: "low" }, perModel: { opus: "max" } },
};

describe("catalog", () => {
  it("parses premium multipliers", () => {
    assert.equal(parseMultiplier("0.33x"), 0.33);
    assert.equal(parseMultiplier("15x"), 15);
    assert.equal(parseMultiplier("1"), 1);
    assert.equal(parseMultiplier(undefined), null);
    assert.equal(parseMultiplier("lots"), null);
  });

  it("normalizes the live list: no auto, no duplicates, enablement kept", () => {
    assert.deepEqual(LIVE.map((m) => m.id), ["haiku", "sonnet", "astra", "opus", "off"]);
    assert.equal(LIVE.find((m) => m.id === "off").enabled, false);
  });

  it("guesses tiers for models the config does not list", () => {
    assert.equal(tierOf("x", {}, { multiplier: 15 }), 3);
    assert.equal(tierOf("x", {}, { multiplier: 0.33 }), 0);
    assert.equal(tierOf("x", {}, { multiplier: 1, priceCategory: "very_high" }), 2);
    assert.equal(tierOf("x", {}, { multiplier: 1, priceCategory: "low" }), 1);
    assert.equal(tierOf("haiku", CONFIG, { multiplier: 1 }), 0, "the config wins over the guess");
  });

  it("merges config and live data, excluding what cannot be used", () => {
    const { models, excluded, live } = buildCatalog(CONFIG, LIVE);
    assert.equal(live, true);
    assert.deepEqual(models.map((m) => m.id), ["haiku", "sonnet", "opus"]);
    assert.deepEqual(excluded.map((e) => e.id).sort(), ["astra", "off"]);
  });

  it("falls back to the configured ids without a live catalog", () => {
    const { models, live } = buildCatalog(CONFIG, null);
    assert.equal(live, false);
    assert.ok(models.some((m) => m.id === "sonnet"));
  });

  it("resolves model → tier → default in that order", () => {
    const { models } = buildCatalog(CONFIG, LIVE);
    assert.equal(resolveSelection({ modelId: "opus" }, models, CONFIG).model.id, "opus");
    assert.equal(resolveSelection({ tier: 0 }, models, CONFIG).model.id, "haiku");
    const def = resolveSelection({}, models, CONFIG);
    assert.equal(def.model.id, "sonnet", "unknown preferred ids are skipped");
    assert.equal(def.source, "default-tier");
    const pinned = resolveSelection({}, models, { ...CONFIG, defaults: { model: "haiku" } });
    assert.equal(pinned.model.id, "haiku");
    assert.equal(pinned.source, "default-model");
  });

  it("rejects unusable models and empty tiers", () => {
    const { models } = buildCatalog(CONFIG, LIVE);
    assert.throws(() => resolveSelection({ modelId: "astra" }, models, CONFIG), (e) => e.code === "MODEL_INVALID");
    assert.throws(() => resolveSelection({ tier: 2 }, models, CONFIG), (e) => e.code === "TIER_EMPTY");
    assert.throws(() => resolveSelection({ tier: 7 }, models, CONFIG), (e) => e.code === "TIER_INVALID");
  });

  it("applies the effort policy per model, per tier, then globally", () => {
    assert.equal(resolveEffort(undefined, { id: "opus", tier: 3 }, CONFIG), "max");
    assert.equal(resolveEffort(undefined, { id: "haiku", tier: 0 }, CONFIG), "low");
    assert.equal(resolveEffort(undefined, { id: "sonnet", tier: 1 }, CONFIG), "high");
    assert.equal(resolveEffort("xhigh", { id: "sonnet", tier: 1 }, CONFIG), "xhigh");
    assert.equal(resolveEffort("off", { id: "sonnet", tier: 1 }, CONFIG), null);
    assert.throws(() => resolveEffort("turbo", { id: "sonnet", tier: 1 }, CONFIG), (e) => e.code === "EFFORT_INVALID");
  });

  it("climbs the tier ladder for escalation", () => {
    const { models } = buildCatalog(CONFIG, LIVE);
    assert.equal(nextTierModel(models, CONFIG, "haiku").id, "sonnet");
    assert.equal(nextTierModel(models, CONFIG, "sonnet").id, "opus", "an empty tier is skipped");
    assert.equal(nextTierModel(models, CONFIG, "opus"), null);
  });
});
