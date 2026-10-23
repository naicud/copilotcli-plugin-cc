// One delegated Copilot CLI session, driven over ACP.
//
// Every delegation runs in its own `copilot --acp --stdio` process. That buys
// per-job reasoning effort and per-job tool rules (both are fixed when the
// ACP server starts), isolates a wedged worker from its siblings, and makes
// abort a cheap, certain operation. The session itself persists on disk in
// Copilot's session store, so a later process can pick it up again with
// `session/load` (delegate.resumeSessionID).
//
// The object returned by startCopilotSession() is a live view of the worker:
// status, the current turn's streamed text/reasoning/tool calls, the todo
// plan, and the permission requests waiting for a decision.

import fs from "node:fs";
import path from "node:path";
import { spawnAcpAgent, ACP_PROTOCOL_VERSION, AcpError } from "./acp-client.mjs";
import { resolveCopilotCommand } from "../../scripts/lib/copilot-bin.mjs";

const INIT_TIMEOUT_MS = 60_000;
const MAX_TEXT_CHARS = 200_000;

/** Map our respond() vocabulary onto ACP permission option kinds. */
const RESPONSE_KINDS = {
  once: "allow_once",
  always: "allow_always",
  reject: "reject_once",
};

/**
 * The string permission rules are matched against: the shell command for
 * execute requests, the target path for edits, the title otherwise.
 * @param {object} toolCall - ACP toolCall from session/request_permission
 * @returns {string}
 */
export function permissionSubject(toolCall = {}) {
  const input = toolCall.rawInput ?? {};
  if (typeof input.command === "string" && input.command) return input.command;
  if (Array.isArray(input.commands) && input.commands.length > 0) return input.commands.join(" && ");
  const file = input.fileName ?? input.path ?? input.file_path ?? toolCall.locations?.[0]?.path;
  if (typeof file === "string" && file) return `${toolCall.kind ?? "edit"} ${file}`;
  if (typeof input.url === "string") return `fetch ${input.url}`;
  return String(toolCall.title ?? toolCall.kind ?? "");
}

/**
 * Classify a permission request with the regex rules from config/models.json.
 * Reject rules win over approve rules.
 * @param {object} toolCall
 * @param {{ autoApprove?: string[], autoReject?: string[] }} rules
 * @returns {"once"|"reject"|null}
 */
export function classifyPermission(toolCall, rules = {}) {
  const subject = permissionSubject(toolCall);
  for (const rule of rules.autoReject ?? []) {
    try {
      if (new RegExp(rule).test(subject)) return "reject";
    } catch {}
  }
  for (const rule of rules.autoApprove ?? []) {
    try {
      if (new RegExp(rule).test(subject)) return "once";
    } catch {}
  }
  return null;
}

/**
 * Command-line arguments for one worker process.
 * @param {{ effort?: string|null, allowTools?: string[], denyTools?: string[], extraArgs?: string[] }} opts
 * @returns {string[]}
 */
export function buildAgentArgs(opts = {}) {
  const args = ["--acp", "--stdio", "--no-ask-user"];
  if (opts.effort) args.push("--reasoning-effort", opts.effort);
  for (const tool of opts.allowTools ?? []) args.push(`--allow-tool=${tool}`);
  for (const tool of opts.denyTools ?? []) args.push(`--deny-tool=${tool}`);
  args.push(...(opts.extraArgs ?? []));
  return args;
}

/**
 * Start a worker and open (or reload) its session.
 * @param {object} opts
 * @param {string} opts.cwd - workspace the session runs in
 * @param {string|null} [opts.model] - model id; validated by the agent
 * @param {string|null} [opts.effort] - low|medium|high|xhigh|max
 * @param {string|null} [opts.resumeSessionId] - load this session instead of creating one
 * @param {string[]} [opts.allowTools] - `--allow-tool` patterns
 * @param {string[]} [opts.denyTools] - `--deny-tool` patterns
 * @param {() => ({ autoApprove?: string[], autoReject?: string[] })} [opts.rules] - re-read per request
 * @param {"ask"|"approve"|"reject"} [opts.unmatched] - what to do with a request no rule decides:
 *   "ask" queues it for respond() (MCP supervision); the others decide on the spot (background jobs)
 * @param {(kind: string, text: string) => void} [opts.onActivity]
 * @param {(turn: object, session: CopilotSession) => void} [opts.onTurnEnd] - after every turn
 * @param {Record<string,string>} [opts.env]
 * @returns {Promise<CopilotSession>}
 */
export async function startCopilotSession(opts) {
  const session = new CopilotSession(opts);
  try {
    await session.open();
  } catch (err) {
    await session.close({ graceMs: 500 }).catch(() => {});
    throw err;
  }
  return session;
}

export class CopilotSession {
  constructor(opts) {
    this.opts = opts;
    this.cwd = opts.cwd;
    this.id = null;
    this.model = opts.model ?? null;
    this.effort = opts.effort ?? null;
    this.models = [];
    this.status = "starting"; // starting | idle | busy | exited
    this.exitError = null;
    this.turns = 0;
    this.turn = null;
    this.lastTurn = null;
    this.plan = null;
    this.contextUsage = null;
    this.pending = new Map();
    this.waiters = new Set();
    this.lastActivityAt = Date.now();
    this.permissionLog = [];
    // Paths inside the workspace are shown relative to it in activity lines.
    let real = this.cwd;
    try {
      real = fs.realpathSync.native(this.cwd);
    } catch {}
    this.cwdPrefixes = [...new Set([this.cwd, real])].filter(Boolean).map((p) => p.replace(/[\\/]+$/, "") + path.sep);
  }

  /** Text with workspace paths made relative, for display only. */
  relative(text) {
    return this.cwdPrefixes.reduce((t, prefix) => t.split(prefix).join(""), String(text));
  }

  /** Human-readable one-liner for a tool call: `$ cmd`, `edit src/a.js`, or the title. */
  describeTool(entry) {
    if (entry.command) return `$ ${this.relative(entry.command)}`;
    if (entry.path) return `${entry.kind ?? "tool"} ${this.relative(entry.path)}`;
    return `${entry.kind ?? "tool"} ${this.relative(entry.title ?? "")}`.trim();
  }

  async open() {
    const { command, prefix } = resolveCopilotCommand();
    const args = [...prefix, ...buildAgentArgs(this.opts)];
    this.conn = spawnAcpAgent({
      command,
      args,
      cwd: this.cwd,
      env: this.opts.env,
      onNotification: (method, params) => this.#onNotification(method, params),
      onRequest: (method, params) => this.#onRequest(method, params),
      onExit: () => {
        this.status = "exited";
        for (const entry of this.pending.values()) entry.resolve({ outcome: { outcome: "cancelled" } });
        this.pending.clear();
        this.#wake();
      },
    });
    this.pid = this.conn.pid;

    await this.conn.request(
      "initialize",
      { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
      { timeoutMs: INIT_TIMEOUT_MS }
    );

    let opened;
    if (this.opts.resumeSessionId) {
      try {
        opened = await this.conn.request(
          "session/load",
          { sessionId: this.opts.resumeSessionId, cwd: this.cwd, mcpServers: [] },
          { timeoutMs: INIT_TIMEOUT_MS }
        );
      } catch (err) {
        throw Object.assign(new Error(`session "${this.opts.resumeSessionId}" could not be loaded: ${err.message}`), {
          code: "RESUME_SESSION_NOT_FOUND",
        });
      }
      this.id = this.opts.resumeSessionId;
      // Loading replays the stored conversation as session/update
      // notifications; none of it belongs to a live turn.
      this.turn = null;
    } else {
      opened = await this.conn.request("session/new", { cwd: this.cwd, mcpServers: [] }, { timeoutMs: INIT_TIMEOUT_MS });
      this.id = opened?.sessionId;
      if (!this.id) throw Object.assign(new Error("session/new returned no sessionId"), { code: "ACP_PROTOCOL" });
    }
    this.models = Array.isArray(opened?.models?.availableModels) ? opened.models.availableModels : [];
    const current = opened?.models?.currentModelId ?? null;

    if (this.model && this.model !== current) {
      try {
        await this.conn.request("session/set_model", { sessionId: this.id, modelId: this.model }, { timeoutMs: INIT_TIMEOUT_MS });
      } catch (err) {
        const ids = [...new Set(this.models.map((m) => m.modelId))].join(", ");
        throw Object.assign(new Error(`model "${this.model}" is not available to this Copilot account${ids ? ` (available: ${ids})` : ""}`), {
          code: "MODEL_INVALID",
          cause: err,
        });
      }
    } else if (!this.model) {
      this.model = current;
    }
    this.status = "idle";
    this.#activity("lifecycle", `session ${this.id} ready (model=${this.model ?? "default"}${this.effort ? ` effort=${this.effort}` : ""}, pid ${this.pid})`);
    return this;
  }

  /**
   * Start a turn. Returns immediately; observe it through status/waitForChange.
   * @param {string} text
   */
  prompt(text) {
    if (this.status === "exited") {
      throw Object.assign(new Error("the Copilot worker for this session has exited"), { code: "SESSION_EXITED" });
    }
    if (this.status === "busy") {
      throw Object.assign(new Error("session is busy with another turn"), { code: "SESSION_BUSY" });
    }
    this.status = "busy";
    this.turns += 1;
    this.turn = {
      index: this.turns,
      startedAt: Date.now(),
      assistant: "",
      reasoning: "",
      tools: new Map(),
      stopReason: null,
      usage: null,
      error: null,
      finishedAt: null,
    };
    const turn = this.turn;
    this.lastActivityAt = Date.now();
    this.promise = this.conn
      .request("session/prompt", { sessionId: this.id, prompt: [{ type: "text", text }] })
      .then((result) => {
        turn.stopReason = result?.stopReason ?? "end_turn";
        turn.usage = result?.usage ?? null;
      })
      .catch((err) => {
        turn.error = {
          name: err instanceof AcpError ? "AcpError" : err?.code ?? "Error",
          message: String(err?.message ?? err),
          ...(err?.rpcCode != null ? { rpcCode: err.rpcCode } : {}),
          ...(err?.data != null ? { data: err.data } : {}),
        };
        turn.stopReason = turn.stopReason ?? "error";
      })
      .finally(() => {
        turn.finishedAt = Date.now();
        this.lastTurn = turn;
        if (this.status !== "exited") this.status = "idle";
        this.#activity(
          turn.error ? "error" : "lifecycle",
          turn.error
            ? `turn ${turn.index} failed — ${turn.error.message}`
            : `turn ${turn.index} ended (${turn.stopReason})${turn.usage ? ` tokens in=${turn.usage.inputTokens ?? "?"} out=${turn.usage.outputTokens ?? "?"}` : ""}`
        );
        this.#wake();
        try {
          this.opts.onTurnEnd?.(turn, this);
        } catch {}
      });
  }

  /** Whether a turn is running right now. */
  get busy() {
    return this.status === "busy";
  }

  /** Permission requests waiting for respond(), oldest first. */
  pendingList() {
    return [...this.pending.values()].map(({ resolve, ...rest }) => rest);
  }

  /**
   * Answer a pending permission request.
   * @param {string} permissionId
   * @param {"once"|"always"|"reject"} response
   * @returns {boolean} whether a request was answered
   */
  respond(permissionId, response) {
    const entry = this.pending.get(permissionId);
    if (!entry) return false;
    const kind = RESPONSE_KINDS[response];
    if (!kind) {
      throw Object.assign(new Error('response must be "once", "always" or "reject"'), { code: "RESPONSE_INVALID" });
    }
    const option = entry.options.find((o) => o.kind === kind) ?? entry.options.find((o) => o.optionId === kind);
    this.pending.delete(permissionId);
    entry.resolve(option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } });
    this.permissionLog.push({ id: permissionId, subject: entry.subject, decision: response, by: "supervisor" });
    this.#activity("permission", `${response.toUpperCase()} ${this.relative(entry.subject)}`);
    this.#wake();
    return true;
  }

  /** Cancel the running turn (pending permission requests are cancelled too). */
  cancel() {
    for (const entry of this.pending.values()) entry.resolve({ outcome: { outcome: "cancelled" } });
    this.pending.clear();
    if (this.status === "busy") this.conn.notify("session/cancel", { sessionId: this.id });
    this.#activity("lifecycle", "cancel requested");
  }

  /**
   * Resolve on the next state change (turn end, permission ask, process exit)
   * or after timeoutMs, whichever comes first.
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} true when woken by a change
   */
  waitForChange(timeoutMs) {
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(false);
      }, Math.max(0, timeoutMs));
      timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  /** Resolve when the current turn (if any) has finished. */
  async settled() {
    if (this.promise) await this.promise.catch(() => {});
  }

  /**
   * Stop the worker. Cancels a running turn first so the session on disk is
   * left in a resumable state.
   */
  async close({ graceMs = 3000 } = {}) {
    if (!this.conn) return;
    if (this.status === "busy") {
      this.cancel();
      await Promise.race([this.settled(), new Promise((r) => setTimeout(r, Math.min(graceMs, 5000)))]);
    }
    await this.conn.close({ graceMs });
    this.status = "exited";
  }

  /** Compact todo summary from the agent's latest plan update. */
  todoSummary() {
    if (!Array.isArray(this.plan) || this.plan.length === 0) return null;
    const counts = {};
    for (const entry of this.plan) counts[entry.status ?? "pending"] = (counts[entry.status ?? "pending"] ?? 0) + 1;
    const current = this.plan.find((e) => e.status === "in_progress") ?? null;
    return { counts, current: current?.content ?? null, total: this.plan.length };
  }

  /** Most recent tool calls of the current (or last) turn, newest last. */
  recentTools(n = 5) {
    const turn = this.turn ?? this.lastTurn;
    if (!turn) return [];
    return [...turn.tools.values()].slice(-n).map((t) => `${this.describeTool(t)} (${t.status ?? "?"})`);
  }

  #wake() {
    for (const waiter of [...this.waiters]) waiter();
  }

  #activity(kind, text) {
    this.lastActivityAt = Date.now();
    try {
      this.opts.onActivity?.(kind, text);
    } catch {}
  }

  #onNotification(method, params) {
    if (method !== "session/update" || params?.sessionId !== this.id) return;
    const update = params.update ?? {};
    const turn = this.turn;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = update.content?.type === "text" ? update.content.text ?? "" : "";
        if (turn && text) {
          turn.assistant = (turn.assistant + text).slice(-MAX_TEXT_CHARS);
          this.#activity("assistant", text);
        }
        return;
      }
      case "agent_thought_chunk": {
        const text = update.content?.type === "text" ? update.content.text ?? "" : "";
        if (turn && text) {
          turn.reasoning = (turn.reasoning + text).slice(-MAX_TEXT_CHARS);
          this.#activity("reasoning", text);
        }
        return;
      }
      case "tool_call": {
        if (!turn) return;
        const raw = update.rawInput ?? {};
        const entry = {
          id: update.toolCallId,
          title: update.title ?? null,
          kind: update.kind ?? null,
          status: update.status ?? "pending",
          command: typeof raw.command === "string" ? raw.command.replace(/\s+/g, " ").slice(0, 200) : null,
          path: [raw.path, raw.fileName, raw.file_path, update.locations?.[0]?.path].find((p) => typeof p === "string") ?? null,
        };
        turn.tools.set(update.toolCallId, entry);
        this.#activity("tool", `${this.describeTool(entry)} (${entry.status})`);
        return;
      }
      case "tool_call_update": {
        if (!turn) return;
        const entry = turn.tools.get(update.toolCallId) ?? { id: update.toolCallId, title: update.title ?? null, kind: update.kind ?? null };
        const previous = entry.status;
        if (update.status) entry.status = update.status;
        if (update.title) entry.title = update.title;
        turn.tools.set(update.toolCallId, entry);
        if (update.status && update.status !== previous && (update.status === "completed" || update.status === "failed")) {
          const detail = update.status === "failed" ? update.rawOutput?.message ?? "" : outputPreview(update);
          this.#activity("tool", `${this.describeTool(entry)} (${update.status})${detail ? ` → ${detail}` : ""}`);
        }
        return;
      }
      case "plan": {
        this.plan = Array.isArray(update.entries) ? update.entries : null;
        const summary = this.todoSummary();
        if (summary) this.#activity("plan", `${summary.counts.completed ?? 0}/${summary.total} done${summary.current ? ` — now: ${summary.current}` : ""}`);
        return;
      }
      case "usage_update": {
        this.contextUsage = { used: update.used ?? null, size: update.size ?? null };
        return;
      }
      default:
        return;
    }
  }

  async #onRequest(method, params) {
    if (method !== "session/request_permission") return undefined;
    const toolCall = params.toolCall ?? {};
    const options = Array.isArray(params.options) ? params.options : [];
    const subject = permissionSubject(toolCall);
    let rules = {};
    try {
      rules = this.opts.rules?.() ?? {};
    } catch {}
    let decision = classifyPermission(toolCall, rules);
    let by = "rule";
    if (!decision && this.opts.unmatched === "approve") {
      decision = "once";
      by = "policy";
    } else if (!decision && this.opts.unmatched === "reject") {
      decision = "reject";
      by = "policy";
    }
    if (decision) {
      const kind = RESPONSE_KINDS[decision];
      const option = options.find((o) => o.kind === kind);
      this.permissionLog.push({ id: toolCall.toolCallId ?? null, subject, decision, by });
      this.#activity("permission", `${decision === "reject" ? "AUTO-REJECT" : "AUTO-APPROVE"} ${this.relative(subject)}`);
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    }

    const id = toolCall.toolCallId ?? `perm-${Date.now().toString(36)}-${this.pending.size}`;
    this.#activity("permission", `ASKED id=${id} ${this.relative(subject)}`);
    return new Promise((resolve) => {
      this.pending.set(id, {
        id,
        kind: toolCall.kind ?? null,
        title: toolCall.title ?? null,
        subject,
        options: options.map((o) => ({ optionId: o.optionId, kind: o.kind, name: o.name })),
        askedAt: new Date().toISOString(),
        resolve,
      });
      this.#wake();
    });
  }
}

function outputPreview(update) {
  const content = Array.isArray(update.content) ? update.content : [];
  for (const part of content) {
    const text = part?.content?.text ?? part?.text;
    if (typeof text === "string" && text.trim()) return text.replace(/<shellId:[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  }
  return "";
}
