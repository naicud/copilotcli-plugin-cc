import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  emitLog,
  setLogSink,
  setLogLevel,
  getLogLevel,
  resetMcpLog,
  LOG_LEVELS,
} from "../plugins/copilot/mcp/lib/mcp-log.mjs";

/** Capture process.stderr.write for the duration of fn(). */
function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return lines.join("");
}

beforeEach(() => {
  resetMcpLog();
});

describe("mcp-log", () => {
  it("default floor is info; debug is suppressed", () => {
    assert.equal(getLogLevel(), "info");
    assert.equal(emitLog("debug", "noisy detail"), false);
  });

  it("emits a spec-shaped notifications/message frame through the sink", () => {
    const frames = [];
    setLogSink((f) => frames.push(f));
    assert.equal(emitLog("notice", "hello world", { data: { a: 1 }, force: true }), true);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].jsonrpc, "2.0");
    assert.equal(frames[0].method, "notifications/message");
    assert.deepEqual(frames[0].params, { level: "notice", logger: "copilot", data: { a: 1 } });
  });

  it("data defaults to the message string", () => {
    const frames = [];
    setLogSink((f) => frames.push(f));
    emitLog("info", "plain line", { force: true });
    assert.equal(frames[0].params.data, "plain line");
  });

  it("setLevel raises the floor; unknown levels are ignored", () => {
    const frames = [];
    setLogSink((f) => frames.push(f));
    assert.equal(setLogLevel("warning"), "warning");
    assert.equal(emitLog("info", "below floor"), false);
    assert.equal(emitLog("error", "above floor", { force: true }), true);
    assert.equal(setLogLevel("not-a-level"), "warning");
    assert.equal(setLogLevel(undefined), "warning");
  });

  it("identical messages throttle within the window; force bypasses", () => {
    const frames = [];
    setLogSink((f) => frames.push(f));
    assert.equal(emitLog("info", "same"), true);
    assert.equal(emitLog("info", "same"), false);
    assert.equal(emitLog("info", "same", { force: true }), true);
    assert.equal(frames.length, 2);
  });

  it("different messages do not collide in the throttle map", () => {
    setLogSink(() => {});
    assert.equal(emitLog("info", "one"), true);
    assert.equal(emitLog("info", "two"), true);
  });

  it("mirrors every emission to stderr with the [copilot:<level>] tag", () => {
    setLogSink(() => {}); // sink present so frame path is exercised too
    const err = captureStderr(() => {
      emitLog("warning", "disk almost full", { force: true });
      emitLog("debug", "never emitted");
    });
    assert.match(err, /\[copilot:warning\] disk almost full/);
    assert.ok(!err.includes("never emitted"));
  });

  it("structured data is JSON-appended on stderr, string data is not doubled", () => {
    const err = captureStderr(() => {
      emitLog("info", "obj case", { data: { k: 1 }, force: true });
      emitLog("info", "str case", { data: "already text", force: true });
    });
    assert.match(err, /\[copilot:info\] obj case {"k":1}/);
    assert.match(err, /\[copilot:info\] str case\n/);
    assert.ok(!err.includes('"already text"'));
  });

  it("a throwing sink never propagates", () => {
    setLogSink(() => {
      throw new Error("broken pipe");
    });
    assert.doesNotThrow(() => emitLog("error", "still alive", { force: true }));
  });

  it("no sink configured: still mirrors to stderr and returns true", () => {
    const err = captureStderr(() => {
      assert.equal(emitLog("critical", "no sink here", { force: true }), true);
    });
    assert.match(err, /\[copilot:critical\] no sink here/);
  });

  it("unknown level names fall back to info severity", () => {
    const frames = [];
    setLogSink((f) => frames.push(f));
    emitLog("bogus-level", "mystery", { force: true });
    assert.equal(frames[0].params.level, "info");
  });

  it("LOG_LEVELS follows MCP severity order", () => {
    assert.deepEqual(LOG_LEVELS, ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]);
  });
});
