import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateModelConfig,
  setModelTier,
  setDefaultModel,
  setExcluded,
  setEffort,
  describeChanges,
} from "../plugins/copilot/mcp/lib/model-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "plugins", "copilot", "config", "models.json"), "utf8"));
const BASE = {
  defaults: { tier: 1 },
  tiers: { 0: { models: ["a"] }, 1: { models: ["b", "c"] } },
  excluded: [],
  effortPolicy: { default: "high" },
  contract: "write ${reportPath}",
};

describe("model config", () => {
  it("ships a valid config", () => {
    assert.deepEqual(validateModelConfig(SHIPPED), []);
  });

  it("flags structural problems", () => {
    const problems = validateModelConfig({
      tiers: { 5: { models: ["x"] }, 1: { models: ["a"] }, 2: { models: ["a"] } },
      defaults: { tier: 9 },
      effortPolicy: { default: "turbo" },
      contract: "no placeholder",
    });
    assert.ok(problems.some((p) => /tier keys must be 0-3/.test(p)));
    assert.ok(problems.some((p) => /listed in both tier 1 and tier 2/.test(p)));
    assert.ok(problems.some((p) => /defaults.tier/.test(p)));
    assert.ok(problems.some((p) => /effortPolicy.default/.test(p)));
    assert.ok(problems.some((p) => /reportPath/.test(p)));
  });

  it("moves a model to the front of a tier without mutating the input", () => {
    const res = setModelTier(BASE, { id: "c", tier: 0 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.config.tiers["0"].models, ["c", "a"]);
    assert.deepEqual(res.config.tiers["1"].models, ["b"]);
    assert.deepEqual(BASE.tiers["1"].models, ["b", "c"], "input untouched");
    assert.equal(setModelTier(BASE, { id: "c", tier: 4 }).code, "TIER_INVALID");
  });

  it("sets and clears the default model; excluding it clears it too", () => {
    const set = setDefaultModel(BASE, { id: "b" }).config;
    assert.equal(set.defaults.model, "b");
    assert.equal(setDefaultModel(set, { id: null }).config.defaults.model, undefined);
    const excluded = setExcluded(set, { id: "b", exclude: true, reason: "flaky" }).config;
    assert.deepEqual(excluded.excluded, [{ id: "b", reason: "flaky" }]);
    assert.equal(excluded.defaults.model, undefined);
    assert.deepEqual(setExcluded(excluded, { id: "b", exclude: false }).config.excluded, []);
  });

  it("sets effort per scope and reports the diff", () => {
    const res = setEffort(BASE, { scope: { kind: "tier", tier: 0 }, level: "low" });
    assert.deepEqual(res.config.effortPolicy.perTier, { 0: "low" });
    assert.equal(setEffort(BASE, { scope: { kind: "global" }, level: "off" }).config.effortPolicy.default, undefined);
    assert.equal(setEffort(BASE, { scope: { kind: "nope" }, level: "low" }).code, "SCOPE_INVALID");
    assert.equal(setEffort(BASE, { scope: { kind: "global" }, level: "turbo" }).code, "EFFORT_INVALID");
    assert.deepEqual(describeChanges(BASE, res.config), ['effortPolicy: {"default":"high"} → {"default":"high","perTier":{"0":"low"}}']);
    assert.deepEqual(describeChanges(BASE, BASE), ["(no change)"]);
  });
});
