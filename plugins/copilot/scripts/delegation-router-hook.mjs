#!/usr/bin/env node
// PreToolUse hook (matcher: "Task|Agent") — autonomous delegation router.
//
// When Claude is about to spawn a subagent for heavy work (builds, test runs,
// refactors, reviews, migrations), this hook inspects the request and says —
// right at the decision point — that the job is a strong candidate for
// Copilot delegation instead of a local subagent, with a ready-made
// delegate/wait recipe.
//
// Protocol: reads one JSON object from stdin ({tool_name, tool_input}).
// Emits a JSON decision on stdout when routing fires; stays silent otherwise.
// NEVER blocks: permissionDecision is always "allow".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  classifyDelegation,
  normalizeSubagentInput,
  SUBAGENT_TOOL_NAMES,
} from "../mcp/lib/delegation-router.mjs";
import { toolRef } from "./lib/tools.mjs";

const MODELS_CONFIG =
  process.env.CP_MODELS_CONFIG ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "models.json");

/** Optional `routing` section of config/models.json; missing file/section → {}. */
function loadRouting() {
  try {
    const config = JSON.parse(readFileSync(MODELS_CONFIG, "utf8"));
    return config.routing && typeof config.routing === "object" ? config.routing : {};
  } catch {
    return {};
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    // stdin may already be closed or never arrive — fail open after a moment
    setTimeout(() => resolve(data), 2000);
  });
}

const raw = await readStdin();
let input = null;
try {
  input = JSON.parse(raw);
} catch {
  // malformed payload: stay silent, allow everything
}

if (input && SUBAGENT_TOOL_NAMES.includes(input.tool_name)) {
  const verdict = classifyDelegation(normalizeSubagentInput(input.tool_input ?? {}), loadRouting());
  if (verdict.route) {
    const advice =
      `${verdict.reason} This subagent task is a strong candidate for Copilot delegation: ` +
      `call ${toolRef("delegate")} {task:<the prompt>, autoRetry:true} WITHOUT tier/model ` +
      `(the resolver picks the configured default tier — do not jump to a premium-multiplier tier unasked), then wait ` +
      `{sessionID} until idle, verify artifacts yourself, use diff {sessionID} for the blast radius, ` +
      `and ${toolRef("logs")} {sessionID} to see its reasoning and activity.`;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: advice,
        },
      }) + "\n"
    );
  }
}
process.exit(0);
