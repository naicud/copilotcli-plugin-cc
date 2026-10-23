#!/usr/bin/env node
// Live demo of the delegation runtime, for the README animation.
//
// Talks to mcp/server.mjs over stdio exactly like Claude Code: handshake →
// live model catalog → delegate a small task to a real Copilot worker →
// supervise it with streamed MCP progress frames (answering permission asks
// the way a supervisor would) → verify the report, the files and the tests →
// clean shutdown. Uses a few AI credits (model: DEMO_MODEL, default
// claude-haiku-5.5; effort: DEMO_EFFORT, default medium). Output is an ANSI transcript meant to
// be piped into make-demo-svg.mjs:
//
//   node plugins/copilot/scripts/demo-delegate.mjs > /tmp/cp-capture.log
//   node plugins/copilot/scripts/make-demo-svg.mjs /tmp/cp-capture.log docs/demo.svg

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.mjs");
const CWD = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cp-demo-")));
const PREFERRED_MODEL = process.env.DEMO_MODEL ?? "claude-haiku-5.5";
const EFFORT = process.env.DEMO_EFFORT ?? "medium";

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const ok = (s) => console.log(`${green("✓")} ${s}`);
const rel = (s) => String(s).split(`${CWD}${path.sep}`).join("").split(CWD).join(".");
const step = (s) => console.log(dim(`\n▸ ${s}`));

fs.writeFileSync(path.join(CWD, "package.json"), JSON.stringify({ name: "demo", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
for (const args of [["init", "-q"], ["add", "."], ["-c", "user.email=demo@local", "-c", "user.name=demo", "commit", "-q", "-m", "init"]]) {
  execFileSync("git", ["-C", CWD, ...args], { stdio: "ignore" });
}

const proc = spawn(process.execPath, [SERVER], {
  cwd: CWD,
  env: { ...process.env, CP_PROGRESS_INTERVAL_MS: process.env.CP_PROGRESS_INTERVAL_MS ?? "4000" },
  stdio: ["pipe", "pipe", "ignore"],
});

let nextId = 1;
const pending = new Map();
const seenProgress = new Set();
readline.createInterface({ input: proc.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === "notifications/progress") {
    // Progress frames repeat while nothing changes; show each state once.
    const text = String(msg.params.message).replace(/^waiting \S+ — /, "");
    // Permission asks get their own line (with the decision) below.
    if (text.startsWith("permission:") || seenProgress.has(text)) return;
    seenProgress.add(text);
    console.log(`  ${cyan("↻")} ${dim(rel(text))}`);
  }
});

const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

async function tool(name, args, meta) {
  const res = await rpc("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  const payload = JSON.parse(res.result.content[0].text);
  if (res.result.isError) throw new Error(`${name}: ${payload.error}`);
  return payload;
}

async function main() {
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "readme-demo", version: "1.0.0" } });
  console.log(`${bold("copilot delegation runtime")} ${dim(`— ${init.result.serverInfo.name}, MCP over stdio`)}`);
  const tools = await rpc("tools/list", {});
  ok(`${tools.result.tools.length} MCP tools ${dim(tools.result.tools.map((t) => t.name).join(" "))}`);

  const catalog = await tool("models", { cwd: CWD });
  const pick =
    catalog.models.find((m) => m.id === PREFERRED_MODEL) ??
    [...catalog.models].sort((a, b) => (a.multiplier ?? 1) - (b.multiplier ?? 1))[0];
  const tiers = [0, 1, 2, 3].map((t) => `${t}:${catalog.models.filter((m) => m.tier === t).length}`).join(" ");
  ok(`${catalog.models.length} models from the live Copilot catalog ${dim(`(per tier ${tiers})`)} · using ${bold(pick.id)}`);

  step("delegate");
  const task = "Add src/slugify.js exporting slugify(text) (lowercase, spaces and punctuation to single dashes, trimmed) and test/slugify.test.js (node:test) covering 3 cases. Verification: npm test.";
  console.log(dim("  task: add src/slugify.js + node:test cases · acceptance: npm test passes"));
  const job = await tool("delegate", { cwd: CWD, task, model: pick.id, effort: EFFORT });
  ok(`worker started · ${bold(job.model)} ${yellow(`${job.multiplier}x`)} · effort ${yellow(job.effort)} · session ${dim(job.sessionID.slice(0, 8))}`);

  step("supervise (live MCP progress)");
  let last;
  for (;;) {
    last = await tool("wait", { sessionID: job.sessionID, cwd: CWD }, { progressToken: `demo-${nextId}` });
    if (last.status === "needsInput") {
      for (const p of last.permissions) {
        const safe = /^(npm|node|mkdir|ls|cat)\b/.test(p.command ?? "");
        console.log(`  ${yellow("?")} permission ${rel(p.command)} → ${safe ? green("approved once") : red("rejected")}`);
        await tool("respond", { sessionID: job.sessionID, permissionID: p.id, response: safe ? "once" : "reject" });
      }
      continue;
    }
    if (last.status !== "timeout") break;
  }
  if (last.status !== "idle" || last.outcome !== "completed") throw new Error(`job ended ${last.status}/${last.outcome}: ${JSON.stringify(last.error ?? {})}`);
  ok(`worker finished · report ${bold(last.report?.status ?? "missing")}`);

  step("verify");
  const diff = await tool("diff", { sessionID: job.sessionID, cwd: CWD });
  ok(`changed: ${diff.files.join(", ")}`);
  // The tap reporter has stable "# pass N" / "# fail N" summary lines.
  const out = execFileSync(process.execPath, ["--test", "--test-reporter=tap"], { cwd: CWD, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const passed = /^# pass (\d+)/m.exec(out)?.[1] ?? "?";
  const failed = /^# fail (\d+)/m.exec(out)?.[1] ?? "?";
  ok(`tests re-run by the supervisor: ${bold(`${passed} passed, ${failed} failed`)}`);
  ok(`usage: ${bold(`${last.aiCredits} AI credits`)} · ${last.premiumRequests} premium request(s)`);

  step("shutdown");
  const sd = await tool("shutdown", { cwd: CWD });
  ok(`worker closed when its turn ended · shutdown found ${sd.stopped.length + sd.orphans.length} process(es) left`);
  console.log(`\n${green(bold("demo complete"))}`);
}

main()
  .catch((err) => {
    console.log(red(`demo failed: ${err.message}`));
    process.exitCode = 1;
  })
  .finally(() => {
    proc.stdin.end();
    fs.rmSync(CWD, { recursive: true, force: true });
  });
