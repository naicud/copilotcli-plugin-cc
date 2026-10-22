import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import {
  resolveCopilotCommand,
  getCopilotVersion,
  detectAuth,
  readSessionAccounting,
  discardEmptySession,
} from "../plugins/copilot/scripts/lib/copilot-bin.mjs";
import { FAKE_BIN } from "./fake-env.mjs";

let home;
const saved = {};

beforeEach(() => {
  home = createTmpDir("copilot-home");
  for (const k of ["COPILOT_HOME", "CP_COPILOT_BIN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) saved[k] = process.env[k];
  process.env.COPILOT_HOME = home;
  for (const k of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  cleanupTmpDir(home);
});

function session(id, events) {
  const dir = path.join(home, "session-state", id);
  fs.mkdirSync(dir, { recursive: true });
  if (events) fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
}

describe("copilot binary", () => {
  it("runs a .mjs override under node and reads its version", async () => {
    process.env.CP_COPILOT_BIN = FAKE_BIN;
    assert.deepEqual(resolveCopilotCommand(), { command: process.execPath, prefix: [FAKE_BIN] });
    assert.equal(await getCopilotVersion(), "1.0.102");
  });

  it("reports no version for a missing binary", async () => {
    process.env.CP_COPILOT_BIN = path.join(home, "does-not-exist");
    assert.equal(await getCopilotVersion(), null);
  });
});

describe("auth detection", () => {
  it("prefers a token variable over the recorded login", () => {
    fs.writeFileSync(path.join(home, "config.json"), '// managed file\n{"lastLoggedInUser":{"login":"octocat"}}\n');
    assert.deepEqual(detectAuth(), { source: "login", login: "octocat" });
    process.env.GH_TOKEN = "x";
    assert.deepEqual(detectAuth(), { source: "env", login: null, variable: "GH_TOKEN" });
  });

  it("reports nothing when never logged in", () => {
    assert.deepEqual(detectAuth(), { source: null, login: null });
  });
});

describe("session accounting", () => {
  it("prefers the newest of shutdown snapshot and usage checkpoint", () => {
    session("1111-aaaa-2222-bbbb", [
      { type: "session.usage_checkpoint", data: { totalNanoAiu: 400000000, totalPremiumRequests: 1 } },
      { type: "session.shutdown", data: { accountingSnapshot: { totalNanoAiu: 430678000, totalPremiumRequestCost: 1, codeChanges: { linesAdded: 3, linesRemoved: 1, filesModified: ["/w/a"] } } } },
      { type: "session.resume", data: {} },
      { type: "session.usage_checkpoint", data: { totalNanoAiu: 463265500, totalPremiumRequests: 2 } },
    ]);
    assert.deepEqual(readSessionAccounting("1111-aaaa-2222-bbbb"), { aiCredits: 0.463266, premiumRequests: 2 });
  });

  it("returns null for unknown or malformed ids", () => {
    assert.equal(readSessionAccounting("nope-nope-nope"), null);
    assert.equal(readSessionAccounting("../../etc"), null);
  });
});

describe("discardEmptySession", () => {
  it("removes only an event-less session directory", () => {
    const empty = session("aaaaaaaa-0000-0000-0000-000000000001");
    const used = session("aaaaaaaa-0000-0000-0000-000000000002", [{ type: "session.start", data: {} }]);
    assert.equal(discardEmptySession("aaaaaaaa-0000-0000-0000-000000000001"), true);
    assert.ok(!fs.existsSync(empty));
    assert.equal(discardEmptySession("aaaaaaaa-0000-0000-0000-000000000002"), false);
    assert.ok(fs.existsSync(used));
  });

  it("refuses anything that is not a plain session id", () => {
    assert.equal(discardEmptySession("../config"), false);
    assert.equal(discardEmptySession(""), false);
    assert.equal(discardEmptySession("short"), false);
  });
});
