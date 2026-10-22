// Isolated environment for tests that drive the plugin against the fake
// Copilot CLI (tests/fixtures/fake-copilot.mjs). Import this module BEFORE
// any plugin module: it points every path the plugin touches (Copilot home,
// state dir, models config, the copilot binary) at a fresh temp directory.

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_BIN = path.join(__dirname, "fixtures", "fake-copilot.mjs");
export const PLUGIN_ROOT = path.join(__dirname, "..", "plugins", "copilot");

export const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cp-test-"));
export const COPILOT_HOME = path.join(ROOT, "copilot-home");
export const STATE_DIR = path.join(ROOT, "state");
export const CONFIG_PATH = path.join(ROOT, "models.json");
export const AGENT_LOG = path.join(ROOT, "agent.log");

export const TEST_CONFIG = {
  version: 1,
  defaults: { tier: 1 },
  tiers: {
    0: { use: "cheap", models: ["fake-cheap"] },
    1: { use: "default", models: ["fake-std"] },
    2: { use: "hard", models: ["fake-pro"] },
    3: { use: "premium", models: ["fake-premium"] },
  },
  excluded: [],
  effortPolicy: { default: "high", perTier: { 0: "low" } },
  concurrency: { maxDelegates: 6 },
  retryPolicy: { maxAutoRetries: 2 },
  budget: { maxDailyCredits: null, maxDailyPremiumRequests: null },
  permissions: {
    allowTools: ["write"],
    denyTools: ["shell(git push)"],
    autoApprove: ["^ls\\b"],
    autoReject: ["^rm -rf"],
  },
  contract: "Work only inside ${cwd}. Write the report to ${reportPath}.",
};

fs.mkdirSync(COPILOT_HOME, { recursive: true });
fs.writeFileSync(CONFIG_PATH, JSON.stringify(TEST_CONFIG, null, 2));

process.env.COPILOT_HOME = COPILOT_HOME;
process.env.CP_STATE_DIR = STATE_DIR;
process.env.CP_MODELS_CONFIG = CONFIG_PATH;
process.env.CP_COPILOT_BIN = FAKE_BIN;
process.env.FAKE_COPILOT_LOG = AGENT_LOG;
process.env.CP_COMPANION_SESSION_ID = "claude-test-session";
process.env.CP_WAIT_SLICE_SEC = "5";
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.FAKE_NUDGE;
delete process.env.FAKE_REPLY;
for (const v of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) delete process.env[v];

/** Rewrite the models config for one test (merged over TEST_CONFIG). */
export function writeConfig(overrides = {}) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...TEST_CONFIG, ...overrides }, null, 2));
}

/** A fresh git workspace with one commit. */
export function makeWorkspace(name = "ws") {
  // realpath: git (and so the companion) reports /private/var on macOS.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, `${name}-`)));
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  return dir;
}

/** argv lines the fake agent logged, oldest first. */
export function agentStarts() {
  try {
    return fs.readFileSync(AGENT_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

process.on("exit", () => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {}
});
