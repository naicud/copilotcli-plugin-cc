#!/usr/bin/env node
// Fake GitHub Copilot CLI for the test suite (CP_COPILOT_BIN points here).
//
// `--version` prints a version line. `--acp --stdio` speaks just enough ACP
// to exercise the plugin: initialize, session/new|load|set_model|prompt,
// session/cancel, session/request_permission. What a turn does is scripted by
// directive lines in the prompt text:
//
//   FAKE: say <text>          agent_message_chunk
//   FAKE: think <text>        agent_thought_chunk
//   FAKE: plan                a three-step plan update
//   FAKE: exec <command>      execute tool call (honours --allow-tool/--deny-tool shell rules,
//                             otherwise asks the client for permission)
//   FAKE: report <STATUS>     writes the job report (path taken from the [REPORT] line);
//                             asks permission first unless --allow-tool=write was given
//   FAKE: sleep <ms>          waits (cancellable)
//   FAKE: error <message>     the prompt request fails with a JSON-RPC error
//   FAKE: empty               ends the turn with no output at all
//   FAKE: crash               the process exits mid-turn
//
// A prompt without directives says FAKE_REPLY (default "ok"). The nudge prompt is answered
// per FAKE_NUDGE ("report" = write a COMPLETED report, otherwise stay empty).
// Every turn appends a usage checkpoint (0.25 credits, 1 premium request) to
// $COPILOT_HOME/session-state/<id>/events.jsonl; stdin EOF writes the final
// session.shutdown snapshot. argv of every start is logged to FAKE_COPILOT_LOG.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("GitHub Copilot CLI 1.0.102.\n");
  process.exit(0);
}
if (process.env.FAKE_COPILOT_LOG) {
  fs.appendFileSync(process.env.FAKE_COPILOT_LOG, JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid }) + "\n");
}

const HOME = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
const allow = argv.filter((a) => a.startsWith("--allow-tool=")).map((a) => a.slice("--allow-tool=".length));
const deny = argv.filter((a) => a.startsWith("--deny-tool=")).map((a) => a.slice("--deny-tool=".length));
const MODELS = [
  { modelId: "auto", name: "Auto" },
  { modelId: "fake-cheap", name: "Fake Cheap", _meta: { copilotUsage: "0.33x", copilotEnablement: "enabled", copilotPriceCategory: "low" } },
  { modelId: "fake-std", name: "Fake Standard", _meta: { copilotUsage: "1x", copilotEnablement: "enabled", copilotPriceCategory: "medium" } },
  { modelId: "fake-pro", name: "Fake Pro", _meta: { copilotUsage: "1x", copilotEnablement: "enabled", copilotPriceCategory: "high" } },
  { modelId: "fake-premium", name: "Fake Premium", _meta: { copilotUsage: "15x", copilotEnablement: "enabled", copilotPriceCategory: "high" } },
  { modelId: "fake-disabled", name: "Fake Disabled", _meta: { copilotUsage: "1x", copilotEnablement: "disabled" } },
];

const sessions = new Map(); // id -> { model, credits, requests }
let nextReq = 1000;
const waiting = new Map(); // request id -> resolve
let current = null; // { sessionId, cancelled, wake }

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextReq++;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

function sessionDir(id) {
  return path.join(HOME, "session-state", id);
}

function appendEvent(id, event) {
  fs.mkdirSync(sessionDir(id), { recursive: true });
  fs.appendFileSync(path.join(sessionDir(id), "events.jsonl"), JSON.stringify(event) + "\n");
}

function shellAllowed(command, rules) {
  return rules.some((r) => {
    const m = /^shell\((.*)\)$/.exec(r);
    if (!m) return r === "shell";
    const stem = m[1].replace(/:\*$/, "");
    return command === stem || command.startsWith(`${stem} `);
  });
}

const sleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (current) current.wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });

async function permission(sessionId, toolCall) {
  const res = await ask("session/request_permission", {
    sessionId,
    toolCall,
    options: [
      { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
      { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
      { optionId: "reject_once", kind: "reject_once", name: "Deny" },
    ],
  });
  return res?.outcome?.outcome === "selected" && String(res.outcome.optionId).startsWith("allow");
}

async function runTurn(sessionId, text) {
  const directives = text
    .split("\n")
    .map((l) => /^FAKE:\s*(\w+)\s*(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => ({ op: m[1], arg: m[2] }));
  if (text.startsWith("You ended your turn without producing any output")) {
    if (process.env.FAKE_NUDGE === "report") directives.push({ op: "report", arg: "COMPLETED" }, { op: "say", arg: "done after nudge" });
    else directives.push({ op: "empty", arg: "" });
  }
  if (directives.length === 0) directives.push({ op: "say", arg: process.env.FAKE_REPLY ?? "ok" });

  let n = 0;
  for (const { op, arg } of directives) {
    if (current?.cancelled) return "cancelled";
    n += 1;
    const toolCallId = `toolu_${sessionId.slice(0, 4)}_${n}`;
    if (op === "say") update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${arg}\n` } });
    else if (op === "think") update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: arg } });
    else if (op === "plan")
      update(sessionId, {
        sessionUpdate: "plan",
        entries: [
          { content: "read code", priority: "medium", status: "completed" },
          { content: "change code", priority: "medium", status: "in_progress" },
          { content: "run tests", priority: "medium", status: "pending" },
        ],
      });
    else if (op === "sleep") await sleep(Number(arg) || 100);
    else if (op === "error") throw Object.assign(new Error(arg || "fake failure"), { rpc: true });
    else if (op === "empty") return "end_turn";
    else if (op === "crash") process.exit(3);
    else if (op === "exec") {
      update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: `Run ${arg}`, kind: "execute", status: "pending", rawInput: { command: arg } });
      if (shellAllowed(arg, deny)) {
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: { message: `Permission denied by rule`, code: "denied" } });
        continue;
      }
      const ok = shellAllowed(arg, allow) || (await permission(sessionId, { toolCallId, title: `Run ${arg}`, kind: "execute", status: "pending", rawInput: { command: arg, commands: [arg] } }));
      if (current?.cancelled) return "cancelled";
      if (!ok) {
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: { message: "The user rejected this tool call.", code: "rejected" } });
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Info: Operation cancelled by user" } });
        return "end_turn";
      }
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: `ran ${arg}` } }] });
    } else if (op === "report") {
      const match = /\[REPORT\] Mandatory report path for THIS job: (.+?) — /.exec(text);
      if (!match) continue;
      const file = match[1];
      update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Create report", kind: "edit", status: "pending", rawInput: { path: file } });
      const ok = allow.includes("write") || (await permission(sessionId, { toolCallId, title: "Create file", kind: "edit", status: "pending", rawInput: { fileName: file } }));
      if (current?.cancelled) return "cancelled";
      if (!ok) {
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: { message: "The user rejected this tool call.", code: "rejected" } });
        return "end_turn";
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `STATUS: ${arg || "COMPLETED"}\ngoal: fake\nfiles: []\n`);
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
    }
  }
  return current?.cancelled ? "cancelled" : "end_turn";
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && !msg.method) {
    waiting.get(msg.id)?.(msg.result);
    waiting.delete(msg.id);
    return;
  }
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code, message) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "FakeCopilot", version: "1.0.102" } });
    case "session/new": {
      const id = crypto.randomUUID();
      sessions.set(id, { model: "fake-std", credits: 0, requests: 0 });
      fs.mkdirSync(sessionDir(id), { recursive: true });
      fs.writeFileSync(path.join(sessionDir(id), "workspace.yaml"), `id: ${id}\ncwd: ${p.cwd}\n`);
      return reply({ sessionId: id, models: { availableModels: MODELS, currentModelId: "fake-std" } });
    }
    case "session/load": {
      if (!fs.existsSync(sessionDir(p.sessionId))) return error(-32602, `unknown session ${p.sessionId}`);
      // Like the real CLI, usage keeps accumulating across processes.
      let credits = 0;
      let requests = 0;
      try {
        for (const line of fs.readFileSync(path.join(sessionDir(p.sessionId), "events.jsonl"), "utf8").trim().split("\n")) {
          const e = JSON.parse(line);
          if (e.type === "session.usage_checkpoint") {
            credits = e.data.totalNanoAiu / 1e9;
            requests = e.data.totalPremiumRequests;
          }
        }
      } catch {}
      sessions.set(p.sessionId, { model: "fake-std", credits, requests });
      update(p.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier prompt" } });
      update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier answer" } });
      return reply({ models: { availableModels: MODELS, currentModelId: "fake-std" } });
    }
    case "session/set_model": {
      const ok = MODELS.some((m) => m.modelId === p.modelId && m.modelId !== "auto");
      if (!ok) return error(-32602, `Invalid modelId '${p.modelId}': not one of this session's models.`);
      sessions.get(p.sessionId).model = p.modelId;
      return reply({});
    }
    case "session/cancel":
      if (current && current.sessionId === p.sessionId) {
        current.cancelled = true;
        current.wake?.();
      }
      return;
    case "session/prompt": {
      const text = (p.prompt ?? []).map((c) => c.text ?? "").join("\n");
      current = { sessionId: p.sessionId, cancelled: false, wake: null };
      const s = sessions.get(p.sessionId) ?? { credits: 0, requests: 0 };
      try {
        const stopReason = await runTurn(p.sessionId, text);
        s.credits += 0.25;
        s.requests += 1;
        appendEvent(p.sessionId, { type: "session.usage_checkpoint", data: { totalNanoAiu: Math.round(s.credits * 1e9), totalPremiumRequests: s.requests } });
        reply({ stopReason, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } });
      } catch (err) {
        error(-32603, err.message);
      } finally {
        current = null;
      }
      return;
    }
    default:
      if (msg.id !== undefined) return error(-32601, `Method not found: ${msg.method}`);
  }
});

process.stdin.on("end", () => {
  for (const [id, s] of sessions) {
    if (s.requests === 0) continue;
    appendEvent(id, {
      type: "session.shutdown",
      data: { accountingSnapshot: { totalNanoAiu: Math.round(s.credits * 1e9), totalPremiumRequestCost: s.requests, codeChanges: { linesAdded: 1, linesRemoved: 0, filesModified: [] } } },
    });
  }
  process.exit(0);
});
