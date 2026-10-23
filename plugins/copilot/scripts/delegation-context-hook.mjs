// PostToolUse hook: after a Copilot-delegation MCP tool call, surface the
// outcome as additionalContext so the main thread sees completion / permission
// requests without re-reading raw tool output.
//
// stdin: { tool_name, tool_response } — a single wait/status result, or a
// waitAll batch ({ results: [...] }) reported session by session.
// stdout (only when relevant): { hookSpecificOutput: { hookEventName:
//   "PostToolUse", additionalContext } } — exit 0 always, silent otherwise.

import fs from "node:fs";
import { matchesTool, toolRef } from "./lib/tools.mjs";

const RELEVANT_TOOLS = ["wait", "waitAll", "status"];

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function extractPayload(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const response = parsed?.tool_response ?? {};
  // MCP result shape: { content: [{ type: "text", text }], isError? }
  const text = response?.result?.content?.[0]?.text ?? response?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function contextFor(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.status === "idle") {
    const esc = payload.escalation;
    if (payload.error && esc?.retryable) {
      return [
        "Delegated Copilot session FAILED.",
        `Error: ${JSON.stringify(payload.error)}`,
        esc.suggestModel
          ? `Re-delegate with model "${esc.suggestModel}" (reason: ${esc.reason}).`
          : "No higher tier is available — check the Copilot plan/quota or pick another model.",
      ].join(" ");
    }
    if (payload.error) {
      return [
        "Delegated Copilot session finished with an error (not auto-retryable).",
        `Error: ${JSON.stringify(payload.error)}`,
        payload.response ? `Final message: ${String(payload.response).slice(0, 400)}` : null,
      ].filter(Boolean).join(" ");
    }
    const parts = [
      "Delegated Copilot session finished (idle).",
      payload.response ? `Final message: ${String(payload.response).slice(0, 400)}` : null,
      payload.reportMissing
        ? "The worker wrote NO report, which the contract requires: treat the run as unverified — check the diff and re-run the verification yourself before reporting success."
        : `Before trusting success: read the job report${payload.report?.path ? ` (${payload.report.path})` : " under .cp-reports/"}, check the files it lists exist, and re-run any read-only verification command yourself.`,
    ].filter(Boolean);
    return parts.join(" ");
  }
  if (payload.status === "retried" && payload.newSessionID) {
    return [
      `Delegated Copilot session failed${payload.originalError?.message ? ` (${payload.originalError.message})` : ""} and was re-delegated automatically as job ${payload.retryJobId}${payload.model ? ` on ${payload.model}` : ""}.`,
      `Keep supervising the NEW session with ${toolRef("wait")} {sessionID: "${payload.newSessionID}"}.`,
    ].join(" ");
  }
  if (payload.status === "needsInput" && Array.isArray(payload.permissions)) {
    const list = payload.permissions
      .map((p) => `- ${p.kind ?? "tool"}: ${p.command ?? p.title ?? p.id} (id ${p.id})`)
      .join("\n");
    return [
      "Delegated Copilot session is BLOCKED waiting on a permission decision.",
      list,
      `Decide each one with ${toolRef("respond")}: approve read-only/test commands with response:"once"; reject anything matching git push/commit, rm -rf, sudo, or curl piped to a shell (a reject ends the worker's turn).`,
    ].join("\n");
  }
  if (payload.status === "timeout") {
    const parts = [
      "Delegated Copilot session did not reach idle within the wait timeout. The session is STILL RUNNING — nothing was lost. Call wait again and keep chaining until idle; abort ONLY if the user explicitly asks to kill it.",
    ];
    const progress = payload.progress;
    if (progress?.tail) {
      parts.push(`Latest assistant output tail:\n${progress.tail}`);
    }
    if (progress?.reasoningTail) {
      parts.push(`Reasoning tail:\n${progress.reasoningTail}`);
    }
    if (Array.isArray(progress?.tools) && progress.tools.length > 0) {
      parts.push(`Recent tool calls:\n${progress.tools.join("\n")}`);
    }
    if (progress?.todos) {
      parts.push(`Todo progress: ${JSON.stringify(progress.todos.counts)}${progress.todos.current ? ` — current: ${progress.todos.current}` : ""}.`);
    }
    return parts.join("\n\n");
  }
  return null;
}

/**
 * waitAll returns one result per session: report each session that needs
 * attention, prefixed with its id.
 */
function contextForBatch(results) {
  const parts = results
    .map((r) => {
      const text = contextFor(r);
      return text ? `[session ${r?.sessionID ?? "?"}${r?.jobId ? ` / job ${r.jobId}` : ""}]\n${text}` : null;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

const raw = readStdin();
let parsedInput = null;
try {
  parsedInput = JSON.parse(raw);
} catch {}

if (parsedInput && matchesTool(parsedInput.tool_name ?? "", RELEVANT_TOOLS)) {
  const payload = extractPayload(raw);
  const context = Array.isArray(payload?.results) ? contextForBatch(payload.results) : contextFor(payload);
  if (context) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
      })
    );
  }
}
process.exit(0);
