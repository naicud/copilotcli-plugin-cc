#!/usr/bin/env node
// Live end-to-end check against the real GitHub Copilot CLI (uses credits).
//
// Boots the MCP server over stdio exactly as Claude Code does, delegates a
// small, verifiable task into a throwaway git workspace, supervises it with
// chained wait calls (answering permission asks the way a supervisor would),
// then checks the report, the file the worker wrote, and the recorded usage.
//
//   node plugins/copilot/scripts/e2e-delegate.mjs [--model <id>] [--effort <level>] [--keep]
//
// Defaults to claude-haiku-5.5 (falling back to the cheapest selectable model
// when the account lacks it). Exit code 0 means every check passed; the
// workspace is removed unless --keep is given.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const keep = args.includes("--keep");
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.mjs");

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cp-e2e-")));
fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "cp-e2e", type: "module", scripts: { test: "node --test" } }, null, 2));
for (const cmd of [["init", "-q"], ["add", "."], ["-c", "user.email=e2e@local", "-c", "user.name=e2e", "commit", "-q", "-m", "init"]]) {
  execFileSync("git", ["-C", ws, ...cmd], { stdio: "ignore" });
}

const child = spawn(process.execPath, [SERVER], { cwd: ws, stdio: ["pipe", "pipe", "inherit"] });
let nextId = 1;
const pending = new Map();
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const tool = async (name, toolArgs) => {
  const res = await rpc("tools/call", { name, arguments: toolArgs });
  const payload = JSON.parse(res.result.content[0].text);
  if (res.result.isError) throw new Error(`${name}: ${payload.error}`);
  return payload;
};

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  const models = await tool("models", { cwd: ws });
  check("live catalog", models.live && models.models.length > 0, `${models.models.length} models`);
  const preferred = flag("model") ?? "claude-haiku-5.5";
  const model = models.models.some((m) => m.id === preferred)
    ? preferred
    : [...models.models].sort((a, b) => (a.multiplier ?? 1) - (b.multiplier ?? 1))[0]?.id;

  const started = await tool("delegate", {
    cwd: ws,
    model,
    effort: flag("effort") ?? "low",
    task: [
      "Goal: add a tiny tested utility.",
      "Scope: create src/sum.js exporting `sum(a, b)` (returns a + b) and test/sum.test.js using node:test + node:assert that checks sum(2, 3) === 5. Touch nothing else.",
      "Acceptance: `npm test` passes.",
      "Verification command: npm test",
    ].join("\n"),
  });
  console.log(`delegated ${started.jobId} on ${started.model} (effort ${started.effort}) — session ${started.sessionID}`);

  let result;
  for (let i = 0; i < 40; i += 1) {
    result = await tool("wait", { sessionID: started.sessionID, cwd: ws });
    if (result.status === "needsInput") {
      for (const p of result.permissions) {
        const safe = /^(npm|node|ls|cat|mkdir)\b/.test(p.command ?? "");
        console.log(`permission ${p.id}: ${p.command} → ${safe ? "once" : "reject"}`);
        await tool("respond", { sessionID: started.sessionID, permissionID: p.id, response: safe ? "once" : "reject" });
      }
      continue;
    }
    if (result.status !== "timeout") break;
    console.log(`… still running: ${result.progress?.tools?.at(-1) ?? result.progress?.tail ?? ""}`);
  }

  check("job completed", result.status === "idle" && result.outcome === "completed", `${result.status}/${result.outcome}${result.error ? ` ${result.error.message}` : ""}`);
  check("report written", /^(STATUS:\s*)?COMPLETED\b/i.test(result.report?.status ?? ""), result.report?.status ?? "no report");
  const src = path.join(ws, "src", "sum.js");
  check("worker wrote src/sum.js", fs.existsSync(src));
  let testsPass = false;
  try {
    execFileSync("npm", ["test"], { cwd: ws, stdio: "ignore" });
    testsPass = true;
  } catch {}
  check("npm test passes (re-run by the supervisor)", testsPass);
  check("usage recorded", Number(result.aiCredits) > 0, `${result.aiCredits} AI credits, ${result.premiumRequests} premium request(s)`);
  const diff = await tool("diff", { sessionID: started.sessionID, cwd: ws });
  check("diff sees the change", JSON.stringify(diff).includes("sum"), "");
  const logs = await tool("logs", { jobId: started.jobId, cwd: ws });
  check("activity log captured", logs.lines.length > 0, `${logs.lines.length} lines`);
} catch (err) {
  check("run", false, err.message);
} finally {
  await tool("shutdown", { cwd: ws }).catch(() => {});
  child.stdin.end();
  if (!keep) fs.rmSync(ws, { recursive: true, force: true });
  else console.log(`workspace kept: ${ws}`);
}

const failed = checks.filter((c) => !c.ok).length;
console.log(failed === 0 ? "\nE2E OK" : `\nE2E FAILED (${failed} check(s))`);
process.exit(failed === 0 ? 0 : 1);
