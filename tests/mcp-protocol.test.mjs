import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "plugins", "copilot", "mcp", "server.mjs");

/**
 * Drive the JSON-RPC stdio server: send messages, collect responses.
 * @param {object[]} messages
 * @returns {Promise<object[]>} responses in arrival order
 */
function talkToServer(messages) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OC_MODELS_CONFIG: path.join(createTmpDir(), "unused.json") },
    });
    const responses = [];
    let buffer = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`server timeout; stderr: ${stderr}`));
    }, 10_000);

    proc.stdout.on("data", (d) => {
      buffer += d.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          // ignore non-JSON
          continue;
        }
        // This suite tests request/response protocol shape; server-initiated
        // logging notifications are covered by mcp-logging-stdio.test.mjs.
        if (typeof parsed.method === "string" && parsed.method.startsWith("notifications/")) continue;
        responses.push(parsed);
      }
      if (responses.length >= expected) {
        clearTimeout(timer);
        proc.kill();
        resolve(responses);
      }
    });
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    const expected = messages.filter((m) => m.id !== undefined && !(m.method ?? "").startsWith("notifications/")).length;
    if (expected === 0) {
      // give the server a beat to (not) answer notifications
      setTimeout(() => {
        clearTimeout(timer);
        proc.kill();
        resolve(responses);
      }, 500);
    }
    for (const msg of messages) {
      proc.stdin.write(JSON.stringify(msg) + "\n");
    }
    proc.stdin.end();
  });
}

let tmpDir;

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

describe("mcp-protocol (stdio)", () => {
  it("initialize handshake returns protocol version and capabilities", async () => {
    const [res] = await talkToServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    ]);
    assert.equal(res.jsonrpc, "2.0");
    assert.equal(res.id, 1);
    assert.ok(res.result.protocolVersion);
    assert.deepEqual(res.result.capabilities.tools, {});
    assert.equal(res.result.serverInfo.name, "copilot-delegate");
  });

  it("tools/list exposes exactly the twelve delegation tools", async () => {
    const [res] = await talkToServer([
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["abort", "delegate", "diff", "doctor", "fanOut", "logs", "models", "respond", "shutdown", "status", "wait", "waitAll"]);
    for (const tool of res.result.tools) {
      assert.ok(tool.description, `tool ${tool.name} missing description`);
      assert.ok(tool.inputSchema, `tool ${tool.name} missing inputSchema`);
    }
  });

  it("unknown method with id returns -32601", async () => {
    const [res] = await talkToServer([
      { jsonrpc: "2.0", id: 3, method: "resources/list" },
    ]);
    assert.equal(res.error.code, -32601);
    assert.match(res.error.message, /Method not found/);
  });

  it("notifications get no response at all", async () => {
    const responses = await talkToServer([
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    assert.deepEqual(responses, []);
  });

  it("malformed JSON line yields parse error -32700", async () => {
    const res = await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("timeout"));
      }, 10_000);
      let out = "";
      proc.stdout.on("data", (d) => {
        out += d.toString();
        if (out.includes("\n")) {
          // Skip server-initiated notifications (startup log) — take the first
          // line that carries a response id.
          const line = out.split("\n").find((l) => l.includes('"id"'));
          if (!line) return;
          clearTimeout(timer);
          proc.kill();
          resolve(JSON.parse(line));
        }
      });
      proc.stdin.write("this is not json\n");
      proc.stdin.end();
    });
    assert.equal(res.error.code, -32700);
  });

  it("unknown tools/call returns isError result instead of protocol error", async () => {
    const [res] = await talkToServer([
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } },
    ]);
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Unknown tool/);
  });

  it("tools/call with malformed config returns structured file error (CA-5)", async () => {
    const badConfig = path.join(tmpDir, "broken.json");
    const fs = await import("node:fs");
    fs.writeFileSync(badConfig, "{ broken", "utf8");

    const res = await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [SERVER], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CP_MODELS_CONFIG: badConfig },
      });
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("timeout"));
      }, 15_000);
      let out = "";
      proc.stdout.on("data", (d) => {
        out += d.toString();
        if (out.includes("\n")) {
          // Skip server-initiated notifications (startup log) — take the first
          // line that carries a response id.
          const line = out.split("\n").find((l) => l.includes('"id"'));
          if (!line) return;
          clearTimeout(timer);
          proc.kill();
          resolve(JSON.parse(line));
        }
      });
      proc.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "models", arguments: { cwd: tmpDir } },
        }) + "\n"
      );
      proc.stdin.end();
    });

    assert.equal(res.result.isError, true);
    const payload = JSON.parse(res.result.content[0].text);
    assert.match(payload.error, /not valid JSON/i);
    assert.equal(payload.code, "CONFIG_INVALID");
  });
});
