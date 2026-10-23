import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "./fake-env.mjs";
import { createActivitySink } from "../plugins/copilot/mcp/lib/activity-log.mjs";

describe("activity sink", () => {
  it("coalesces streamed chunks into lines and closes them on a kind change", () => {
    const sink = createActivitySink();
    sink.bind("/w", "delegate-1", "sess-1");
    sink.record("delegate-1", "reasoning", "think");
    sink.record("delegate-1", "reasoning", "ing hard");
    sink.record("delegate-1", "tool", "execute Run tests (pending)");
    sink.record("delegate-1", "assistant", "Hello ");
    sink.record("delegate-1", "assistant", "world");
    const lines = sink.tail("sess-1", 10).map((l) => l.replace(/^\[[\d:.]+\] /, ""));
    assert.deepEqual(lines, ["[reasoning] thinking hard", "[tool] execute Run tests (pending)", "[assistant] Hello world"]);
    assert.deepEqual(sink.tail("delegate-1", 10).length, 3, "job id and session id share one buffer");
  });

  it("closes a streamed line at the newline and keeps the rest open", () => {
    const sink = createActivitySink();
    sink.bind("/w", "delegate-2");
    sink.record("delegate-2", "assistant", "line one\nline t");
    sink.record("delegate-2", "assistant", "wo continues");
    const lines = sink.tail("delegate-2", 10).map((l) => l.replace(/^\[[\d:.]+\] /, ""));
    assert.deepEqual(lines, ["[assistant] line one", "[assistant] line two continues"]);
  });

  it("summarizes the most recent activity for progress frames", () => {
    const sink = createActivitySink();
    sink.bind("/w", "delegate-3", "sess-3");
    sink.record("delegate-3", "reasoning", "planning the change");
    sink.record("delegate-3", "tool", "edit src/a.js (completed)");
    assert.equal(sink.summary("sess-3"), "tool: edit src/a.js (completed)");
    sink.record("delegate-3", "assistant", "patch");
    assert.equal(sink.summary("sess-3"), "tool: edit src/a.js (completed)", "a fresh fragment does not replace the last full line");
    sink.record("delegate-3", "assistant", "ed src/a.js and every caller of the helper");
    assert.equal(sink.summary("sess-3"), "assistant: patched src/a.js and every caller of the helper", "a streaming line wins once it says something");
    sink.record("delegate-3", "lifecycle", "turn 1 ended");
    assert.equal(sink.summary("sess-3"), "assistant: patched src/a.js and every caller of the helper", "lifecycle notes are not activity");
  });

  it("ignores records without a job id", () => {
    const sink = createActivitySink();
    sink.record(null, "tool", "x");
    assert.deepEqual(sink.tail("x"), []);
  });
});
