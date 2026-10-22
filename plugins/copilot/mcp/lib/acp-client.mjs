// Minimal Agent Client Protocol (ACP) client over a child process's stdio.
//
// `copilot --acp --stdio` speaks newline-delimited JSON-RPC 2.0. This module
// owns the transport only: spawning the agent, correlating request ids,
// dispatching notifications and agent→client requests, and failing every
// in-flight call when the process goes away. What a session *means* lives in
// copilot-session.mjs. Zero dependencies, like the rest of the plugin.

import { spawn } from "node:child_process";
import readline from "node:readline";

/** ACP protocol version this client speaks (`initialize.protocolVersion`). */
export const ACP_PROTOCOL_VERSION = 1;

/** Error raised for JSON-RPC error responses, carrying the agent's code. */
export class AcpError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? "unknown ACP error"}`);
    this.name = "AcpError";
    this.code = "ACP_ERROR";
    this.rpcCode = error?.code ?? null;
    this.data = error?.data ?? null;
  }
}

/**
 * Spawn an ACP agent and return a connection to it.
 * @param {object} opts
 * @param {string} opts.command - executable
 * @param {string[]} [opts.args]
 * @param {string} [opts.cwd]
 * @param {Record<string,string>} [opts.env] - merged over process.env
 * @param {(method: string, params: object) => void} [opts.onNotification]
 * @param {(method: string, params: object, id: number|string) => Promise<object>|object} [opts.onRequest]
 *   agent→client requests (e.g. session/request_permission); the resolved
 *   value becomes the JSON-RPC result, a thrown error becomes -32603
 * @param {(line: string) => void} [opts.onStderr]
 * @param {(info: { code: number|null, signal: string|null }) => void} [opts.onExit]
 * @returns {AcpConnection}
 */
export function spawnAcpAgent(opts) {
  return new AcpConnection(opts);
}

export class AcpConnection {
  constructor(opts) {
    this.nextId = 1;
    /** @type {Map<number, { method: string, resolve: Function, reject: Function, timer: any }>} */
    this.pending = new Map();
    this.onNotification = opts.onNotification ?? (() => {});
    this.onRequest = opts.onRequest ?? null;
    this.exited = false;
    this.exitInfo = null;
    this.stderrTail = [];

    this.child = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.pid = this.child.pid ?? null;

    this.child.on("error", (err) => this.#fail(err));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      const tail = this.stderrTail.join("").trim().slice(-600);
      this.#fail(
        Object.assign(
          new Error(`copilot ACP process exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})${tail ? `: ${tail}` : ""}`),
          { code: "ACP_EXITED" }
        )
      );
      opts.onExit?.({ code, signal });
    });
    // A closed stdin (agent already gone) must not crash the host process.
    this.child.stdin.on("error", () => {});

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      opts.onStderr?.(chunk);
    });

    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.#onLine(line));
  }

  /**
   * Send a request and resolve with its result.
   * @param {string} method
   * @param {object} params
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<any>}
   */
  request(method, params, { timeoutMs } = {}) {
    if (this.exited) {
      return Promise.reject(Object.assign(new Error(`copilot ACP process is not running (${method})`), { code: "ACP_EXITED" }));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        Number.isFinite(timeoutMs) && timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(Object.assign(new Error(`${method} timed out after ${timeoutMs}ms`), { code: "ACP_TIMEOUT" }));
            }, timeoutMs)
          : null;
      timer?.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /**
   * Send a notification (no response expected).
   * @param {string} method
   * @param {object} params
   */
  notify(method, params) {
    if (this.exited) return;
    this.#write({ jsonrpc: "2.0", method, params });
  }

  /**
   * Close stdin (the agent shuts down on EOF) and force-kill after a grace.
   * @param {{ graceMs?: number }} [opts]
   * @returns {Promise<void>}
   */
  close({ graceMs = 3000 } = {}) {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      this.child.once("exit", done);
      try {
        this.child.stdin.end();
      } catch {}
      const timer = setTimeout(() => {
        try {
          this.child.kill("SIGTERM");
        } catch {}
        setTimeout(() => {
          if (!this.exited) {
            try {
              this.child.kill("SIGKILL");
            } catch {}
          }
          resolve();
        }, 1000).unref?.();
      }, graceMs);
      timer.unref?.();
    });
  }

  /** Hard stop without waiting. */
  kill() {
    if (this.exited) return;
    try {
      this.child.kill("SIGKILL");
    } catch {}
  }

  #write(msg) {
    try {
      this.child.stdin.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      this.#fail(err);
    }
  }

  #fail(err) {
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }

  async #onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // stdout is protocol-only; stray text is ignored
    }
    if (msg == null || typeof msg !== "object") return;

    // Response to one of our requests.
    if (msg.method === undefined && msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) entry.reject(new AcpError(entry.method, msg.error));
      else entry.resolve(msg.result);
      return;
    }

    // Agent → client request.
    if (typeof msg.method === "string" && msg.id !== undefined) {
      if (!this.onRequest) {
        this.#write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not supported: ${msg.method}` } });
        return;
      }
      try {
        const result = await this.onRequest(msg.method, msg.params ?? {}, msg.id);
        if (result === undefined) {
          this.#write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not supported: ${msg.method}` } });
        } else {
          this.#write({ jsonrpc: "2.0", id: msg.id, result });
        }
      } catch (err) {
        this.#write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(err?.message ?? err) } });
      }
      return;
    }

    // Notification.
    if (typeof msg.method === "string") {
      try {
        this.onNotification(msg.method, msg.params ?? {});
      } catch {
        // a faulty listener must never take the transport down
      }
    }
  }
}
