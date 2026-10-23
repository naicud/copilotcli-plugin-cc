import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkerPrompt,
  renderContract,
  reportPathFor,
  workerToolPolicy,
} from "../plugins/copilot/mcp/lib/worker-prompt.mjs";
import { permissionSubject, classifyPermission, buildAgentArgs, CopilotSession } from "../plugins/copilot/mcp/lib/copilot-session.mjs";

const PERMISSIONS = {
  allowTools: ["write"],
  denyTools: ["shell(git push)"],
  autoApprove: ["^npm test\\b"],
  autoReject: ["^rm -rf"],
};

describe("worker prompt", () => {
  it("substitutes the contract placeholders with a per-job report path", () => {
    const text = renderContract("cwd=${cwd} report=${reportPath}", "/w", "delegate-1");
    assert.equal(text, "cwd=/w report=.cp-reports/delegate-1.md");
  });

  it("assembles persona, contract, task, digest and the absolute report path", () => {
    const prompt = buildWorkerPrompt({ contract: "C ${reportPath}", cwd: "/w", jobId: "delegate-9", task: "do X", persona: "reviewer", skillsDigest: "[PLUGIN SKILLS] y" });
    assert.match(prompt, /read-only reviewer/);
    assert.match(prompt, /C \.cp-reports\/delegate-9\.md/);
    assert.match(prompt, /do X/);
    assert.match(prompt, /\[PLUGIN SKILLS\] y/);
    assert.ok(prompt.includes(`[REPORT] Mandatory report path for THIS job: ${reportPathFor("/w", "delegate-9")} — `));
  });
});

describe("worker tool policy", () => {
  it("passes the configured rules through for builders", () => {
    const p = workerToolPolicy("builder", PERMISSIONS);
    assert.deepEqual(p.allowTools, ["write"]);
    assert.deepEqual(p.denyTools, ["shell(git push)"]);
    assert.deepEqual(p.rules, { autoApprove: ["^npm test\\b"], autoReject: ["^rm -rf"] });
  });

  it("gives reviewers no write grant and only their report file", () => {
    const p = workerToolPolicy("reviewer", PERMISSIONS);
    assert.deepEqual(p.allowTools, []);
    const edit = (file) => classifyPermission({ kind: "edit", rawInput: { fileName: file } }, p.rules);
    assert.equal(edit("/w/.cp-reports/delegate-1.md"), "once");
    assert.equal(edit("C:\\w\\.cp-reports\\delegate-1.md"), "once");
    assert.equal(edit("/w/src/app.js"), "reject");
    assert.equal(edit("/w/.cp-reports/nested/x.md"), "reject");
    assert.equal(classifyPermission({ kind: "execute", rawInput: { command: "npm test" } }, p.rules), "once");
  });
});

describe("permission classification", () => {
  it("matches commands, paths and titles", () => {
    assert.equal(permissionSubject({ rawInput: { command: "ls -la" } }), "ls -la");
    assert.equal(permissionSubject({ rawInput: { commands: ["a", "b"] } }), "a && b");
    assert.equal(permissionSubject({ kind: "edit", rawInput: { fileName: "/w/x" } }), "edit /w/x");
    assert.equal(permissionSubject({ kind: "fetch", rawInput: { url: "https://x" } }), "fetch https://x");
    assert.equal(permissionSubject({ title: "Something" }), "Something");
  });

  it("lets reject rules win and ignores invalid regexes", () => {
    const rules = { autoApprove: ["^rm", "("], autoReject: ["^rm -rf"] };
    assert.equal(classifyPermission({ rawInput: { command: "rm -rf /" } }, rules), "reject");
    assert.equal(classifyPermission({ rawInput: { command: "rm x" } }, rules), "once");
    assert.equal(classifyPermission({ rawInput: { command: "make" } }, rules), null);
  });

  it("describes tool calls with workspace-relative paths", () => {
    const s = new CopilotSession({ cwd: "/work/repo" });
    assert.equal(s.describeTool({ kind: "execute", command: "ls /work/repo/src" }), "$ ls src");
    assert.equal(s.describeTool({ kind: "edit", path: "/work/repo/src/a.js", title: "Editing ...repo/src/a.js" }), "edit src/a.js");
    assert.equal(s.describeTool({ kind: "fetch", title: "Fetch docs" }), "fetch Fetch docs");
  });

  it("builds the worker command line", () => {
    assert.deepEqual(buildAgentArgs({ effort: "max", allowTools: ["write"], denyTools: ["shell(git push)"] }), [
      "--acp",
      "--stdio",
      "--no-ask-user",
      "--reasoning-effort",
      "max",
      "--allow-tool=write",
      "--deny-tool=shell(git push)",
    ]);
    assert.deepEqual(buildAgentArgs({}), ["--acp", "--stdio", "--no-ask-user"]);
  });
});
