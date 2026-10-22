import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpDir } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "plugins", "copilot", "mcp", "server.mjs");

/**
 * Drive the stdio JSON-RPC server until `predicate` sees matching frames
 * (responses AND notifications both land on stdout) or the timeout fires.
 */
function talkUntil(messages, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OC_MODELS_CONFIG: path.join(createTmpDir(), "unused.json") },
    });
    const frames = [];
    let stderr = "";
    let buffer = "";
    const finish = (fn, arg) => {
      proc.kill();
      fn(arg);
    };
    const timer = setTimeout(() => {
      clearInterval(poll);
      finish(reject, new Error(`timeout waiting for frame; stderr: ${stderr}`));
    }, timeoutMs);
    proc.stdout.on("data", (d) => {
      buffer += d.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          frames.push(JSON.parse(line));
        } catch {}
      }
      if (predicate(frames, stderr)) {
        clearTimeout(timer);
        finish(resolve, { frames, stderr });
      }
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (predicate(frames, stderr)) {
        clearTimeout(timer);
        clearInterval(poll);
        finish(resolve, { frames, stderr });
      }
    });
    // Re-evaluate on a short poll: stream events can arrive in either order.
    const poll = setInterval(() => {
      if (predicate(frames, stderr)) {
        clearTimeout(timer);
        clearInterval(poll);
        finish(resolve, { frames, stderr });
      }
    }, 25);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    for (const msg of messages) {
      proc.stdin.write(JSON.stringify(msg) + "\n");
    }
    proc.stdin.end();
  });
}

describe("mcp logging channel (stdio)", () => {
  it("advertises logging capability and answers logging/setLevel with a notification", async () => {
    const { frames } = await talkUntil(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "logging/setLevel", params: { level: "debug" } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ],
      (f) =>
        f.some((x) => x.id === 1) &&
        f.some((x) => x.id === 2) &&
        f.some((x) => x.method === "notifications/message" && /log level set/.test(String(x.params?.data)))
    );
    const init = frames.find((x) => x.id === 1);
    assert.deepEqual(init.result.capabilities.logging, {}, "initialize must advertise logging");
    assert.equal(frames.find((x) => x.id === 2).result.level, "debug");
  });

  it("emits a startup log notification and mirrors it to stderr", async () => {
    const { frames, stderr } = await talkUntil(
      [],
      (f, err) =>
        f.some((x) => x.method === "notifications/message" && /server started/.test(String(x.params?.data))) &&
        err.includes("[copilot:info] copilot delegation server started")
    );
    assert.ok(frames.length >= 1);
  });

  it("unknown tool requests surface as warning notifications on both channels", async () => {
    const { frames, stderr } = await talkUntil(
      [{ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nope", arguments: {} } }],
      (f, err) =>
        f.some((x) => x.id === 9 && x.result?.isError) &&
        f.some((x) => x.method === "notifications/message" && x.params?.level === "warning") &&
        err.includes("[copilot:warning] unknown tool")
    );
    assert.match(stderr, /unknown tool "nope"/);
  });

  it("tools/list still exposes exactly twelve tools; shutdown gains cleanState", async () => {
    const { frames } = await talkUntil(
      [{ jsonrpc: "2.0", id: 3, method: "tools/list" }],
      (f) => f.some((x) => x.id === 3)
    );
    const tools = frames.find((x) => x.id === 3).result.tools;
    assert.equal(tools.length, 12);
    const shutdown = tools.find((t) => t.name === "shutdown");
    assert.ok(shutdown.inputSchema.properties.cleanState, "cleanState arg must be documented");
  });
});
