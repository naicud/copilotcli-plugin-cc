#!/usr/bin/env node

// Stop review gate hook for the Copilot companion.
// When enabled (/copilot:setup --enable-review-gate), runs a targeted,
// read-only Copilot review of Claude's last response before the session is
// allowed to stop. A BLOCK verdict keeps Claude working, with the reviewer's
// reason as the next instruction.
//
// Protocol (Claude Code Stop hook): stdin is { transcript_path,
// stop_hook_active, ... }. To block, print {"decision":"block","reason"} and
// exit 0 — a non-zero exit would only be reported as a hook error. Anything
// else on stdout is informational and lets the stop proceed.

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState } from "./lib/state.mjs";
import { runCopilotPrompt, pickModel } from "./lib/copilot-run.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Last assistant text of a Claude Code JSONL transcript.
 * @param {unknown} transcriptPath
 * @returns {string}
 */
export function lastAssistantFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return "";
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    return "";
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (entry?.type !== "assistant" || !message) continue;
    const content = message.content;
    const chunks = Array.isArray(content)
      ? content.filter((part) => part?.type === "text").map((part) => part.text)
      : typeof content === "string"
        ? [content]
        : [];
    const joined = chunks.join("\n").trim();
    if (joined) return joined;
  }
  return "";
}

function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 5000).unref();
  });
}

async function main() {
  const workspace = await resolveWorkspace();
  if (!loadState(workspace).config?.reviewGate) {
    console.log("ALLOW: Review gate is disabled.");
    return;
  }

  let payload = {};
  try {
    payload = JSON.parse(await readStdin());
  } catch {}
  // Claude is already continuing because a stop hook blocked once: let it
  // stop this time instead of looping review → fix → review.
  if (payload?.stop_hook_active) {
    console.log("ALLOW: Stop already continued once after a review.");
    return;
  }
  const assistantResponse = lastAssistantFromTranscript(payload?.transcript_path);
  if (!assistantResponse) {
    console.log("ALLOW: No response to review.");
    return;
  }

  const template = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "stop-review-gate.md"), "utf8");
  const prompt = template.replace("{{ASSISTANT_RESPONSE_BLOCK}}", `<assistant_response>\n${assistantResponse}\n</assistant_response>`);

  try {
    const { model, effort } = pickModel({});
    const run = await runCopilotPrompt({ cwd: workspace, prompt, model, effort, write: false });
    if (run.error) {
      console.log(`ALLOW: Review gate error: ${run.error.message}`);
      return;
    }
    const firstLine = run.text.trim().split("\n")[0] ?? "";
    if (firstLine.startsWith("BLOCK")) {
      process.stdout.write(JSON.stringify({ decision: "block", reason: `Copilot review gate: ${firstLine}` }) + "\n");
      return;
    }
    console.log(firstLine || "ALLOW: No issues found.");
  } catch (err) {
    // A failing reviewer must never trap the session.
    console.log(`ALLOW: Review gate error: ${err.message}`);
  }
}

main().catch((err) => {
  console.log(`ALLOW: Unhandled error: ${err.message}`);
  process.exit(0);
});
