---
name: copilot-routing
description: Use when the user EXPLICITLY asks for subagents, delegation, Copilot workers, parallel workers, background tasks or fan-out work — routes heavy work to GitHub Copilot CLI workers via the copilot-delegate subagent or the delegate/fanOut tools of the `cp` MCP server. NEVER route proactively on your own judgment; do NOT route routine single-file edits, quick questions, exploration or anything you can finish in a couple of steps.
user-invocable: true
---

# Copilot Routing Guide

Decide WHEN work should leave this thread, then hand it off correctly.

## Route to Copilot (when asked)

- User explicitly asks for subagents, delegates, parallel/background workers, fan-out.
- Heavy implementation: multi-file refactors, migrations, large test suites, builds with long verification loops.
- Reviews/audits that benefit from an isolated reviewer persona (`persona: "reviewer"`).
- Several independent chunks of work at once → `fanOut` (up to 12) + `waitAll`.
- The task needs its own workspace blast-radius isolation → scope it explicitly in the task text (files in/out of scope); the subagent itself runs in the caller's directory, no worktree isolation.

## Keep on the main thread (do NOT delegate)

- Single-file edits, typo fixes, one-function changes.
- Exploration, lookups, quick questions, reading code.
- Anything where shaping a full task contract costs more than doing the work.

When unsure, do it yourself. Delegation pays only when the task is self-contained and verifiable.

## How to hand off

1. Prefer spawning the **copilot-delegate** subagent for substantial single tasks; it runs the full supervise+verify loop itself.
2. Or call the `cp` MCP tools directly:
   - `delegate {task}` — omit tier/model; the resolver applies the configured default tier and effort policy.
   - `wait {sessionID}` until idle / needsInput / retried (timeouts just mean "still running").
   - `logs {sessionID}` to see the worker's streamed reasoning, output, tool calls and permissions live.
   - `diff {sessionID}` for blast radius; verify the job report (`.cp-reports/<jobId>.md`) yourself before trusting success.
3. Parallel batches: `fanOut` once per batch, then `waitAll`.

## Task quality bar

A delegable task states goal (one sentence), in-scope files, verifiable acceptance criteria, and a verification command. Vague asks must be tightened BEFORE delegating (see copilot-prompting).

## Tool names

The tools are the `cp` MCP server's. Claude Code exposes them as
`mcp__plugin_copilot_cp__<tool>` (e.g. `mcp__plugin_copilot_cp__delegate`);
everywhere else in this plugin's skills the bare name (`delegate`, `wait`,
`fanOut`, …) is used.
