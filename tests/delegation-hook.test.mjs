import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, "..", "plugins", "copilot", "scripts", "delegation-context-hook.mjs");

function runHook(stdinPayload) {
  const input = typeof stdinPayload === "string" ? stdinPayload : JSON.stringify(stdinPayload);
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function mcpResult(obj) {
  return { tool_response: { result: { content: [{ type: "text", text: JSON.stringify(obj) }] } } };
}

describe("delegation-context-hook", () => {
  it("emits additionalContext on idle wait result", () => {
    const res = runHook({
      tool_name: "mcp__plugin_copilot_cp__wait",
      ...mcpResult({ status: "idle", response: "COMPLETED. Done work.", cost: 0 }),
    });
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(out.hookSpecificOutput.additionalContext, /idle/);
    assert.match(out.hookSpecificOutput.additionalContext, /\.cp-reports/);
    assert.match(out.hookSpecificOutput.additionalContext, /COMPLETED\. Done work\./);
  });

  it("emits permission decision prompt on needsInput", () => {
    const res = runHook({
      tool_name: "mcp__plugin_copilot_cp__wait",
      ...mcpResult({
        status: "needsInput",
        permissions: [{ id: "per_1", kind: "execute", command: "./weird.sh" }],
      }),
    });
    const out = JSON.parse(res.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /BLOCKED/);
    assert.match(out.hookSpecificOutput.additionalContext, /per_1/);
    assert.match(out.hookSpecificOutput.additionalContext, /respond/);
  });

  it("warns on timeout status", () => {
    const res = runHook({
      tool_name: "mcp__plugin_copilot_cp__wait",
      ...mcpResult({ status: "timeout" }),
    });
    const out = JSON.parse(res.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /timeout/);
  });

  it("timeout context includes progress tail, reasoning, tools and todos when present", () => {
    const res = runHook({
      tool_name: "mcp__plugin_copilot_cp__wait",
      ...mcpResult({
        status: "timeout",
        progress: {
          tail: "editing src/foo.ts...",
          reasoningTail: "considering edge cases...",
          tools: ["[tool] bash npm test", "[tool] edit src/foo.ts"],
          todos: { counts: { completed: 2, in_progress: 1 }, current: "write tests", total: 3 },
        },
      }),
    });
    const out = JSON.parse(res.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /timeout/);
    assert.match(ctx, /editing src\/foo\.ts\.\.\./);
    assert.match(ctx, /Reasoning tail:\nconsidering edge cases\.\.\./);
    assert.match(ctx, /\[tool\] bash npm test/);
    assert.match(ctx, /current: write tests/);
  });

  it("silent for unrelated tools", () => {
    const res = runHook({
      tool_name: "mcp__plugin_copilot_cp__models",
      ...mcpResult({ models: [] }),
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "");
  });

  it("silent for garbage stdin and empty payloads without crashing", () => {
    for (const raw of ["not json", "", JSON.stringify({ tool_name: "x" }), "{}"]) {
      const res = runHook(raw);
      assert.equal(res.status, 0);
      assert.equal(res.stdout.trim(), "");
    }
  });

  it("silent when MCP result is isError or unparseable text", () => {
    const res = runHook({
      tool_name: "mcp__plugin_copilot_cp__wait",
      tool_response: { result: { content: [{ type: "text", text: "{{{bad json" }], isError: true } },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "");
  });

  it("handles direct content shape without result wrapper", () => {
    const res = runHook({
      tool_name: "mcp__plugin_copilot_cp__status",
      tool_response: { content: [{ type: "text", text: JSON.stringify({ status: "idle", response: "ok" }) }] },
    });
    const out = JSON.parse(res.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /idle/);
  });

  it("surfaces retryable failure with escalation suggestion", () => {
    const res = runHook({
      tool_name: "mcp__plugin_copilot_cp__wait",
      ...mcpResult({
        status: "idle",
        error: { name: "AcpError", message: "session/prompt: rate limit exceeded" },
        escalation: { kind: "rate", retryable: true, suggestModel: "gpt-6-astra", reason: "rate failure on claude-sonnet-5.5" },
      }),
    });
    const out = JSON.parse(res.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /FAILED/);
    assert.match(out.hookSpecificOutput.additionalContext, /gpt-6-astra/);
    assert.match(out.hookSpecificOutput.additionalContext, /rate failure/);
  });

  it("non-retryable error gets plain error context without suggestion", () => {
    const res = runHook({
      tool_name: "mcp__plugin_copilot_cp__wait",
      ...mcpResult({
        status: "idle",
        error: { name: "AcpError", message: "turn cancelled" },
        escalation: { kind: "abort", retryable: false },
        response: "partial text",
      }),
    });
    const out = JSON.parse(res.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /not auto-retryable/);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /Re-delegate/);
  });
});

describe("delegation-context-hook — tool names", () => {
  it("stays silent for another server's wait tool", () => {
    const res = runHook({
      tool_name: "mcp__other__wait",
      ...mcpResult({ status: "idle", response: "done" }),
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "");
  });

  it("advises the respond tool under the plugin's qualified name", () => {
    const res = runHook({
      tool_name: "mcp__plugin_copilot_cp__wait",
      ...mcpResult({ status: "needsInput", permissions: [{ id: "p1", kind: "execute", command: "npm test" }] }),
    });
    assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /mcp__plugin_copilot_cp__respond/);
  });

  it("points a retried wait at the new session", () => {
    const res = runHook({
      tool_name: "mcp__plugin_copilot_cp__wait",
      ...mcpResult({ status: "retried", retryJobId: "delegate-2", newSessionID: "sess-2", model: "gpt-6-sol", originalError: { message: "rate limit" } }),
    });
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /delegate-2/);
    assert.match(ctx, /sess-2/);
  });

  it("reports every session of a waitAll batch that needs attention", () => {
    const res = runHook({
      tool_name: "mcp__plugin_copilot_cp__waitAll",
      ...mcpResult({
        results: [
          { status: "idle", outcome: "completed", sessionID: "s-1", jobId: "delegate-1", response: "done one" },
          { status: "needsInput", sessionID: "s-2", permissions: [{ id: "p9", kind: "execute", command: "make deploy" }] },
        ],
        summary: { total: 2 },
      }),
    });
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /\[session s-1 \/ job delegate-1\]/);
    assert.match(ctx, /done one/);
    assert.match(ctx, /\[session s-2\]/);
    assert.match(ctx, /make deploy/);
  });
});
