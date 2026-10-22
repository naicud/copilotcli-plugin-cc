---
description: "Delegate a quick smoke-test of the current workspace changes to Copilot (preset: tier 0, auto-retry, diff-verified)"
argument-hint: '[extra instructions for the test task]'
allowed-tools: Bash(node:*), Bash(git:*), mcp__plugin_copilot_cp__delegate, mcp__plugin_copilot_cp__wait, mcp__plugin_copilot_cp__respond, mcp__plugin_copilot_cp__diff, mcp__plugin_copilot_cp__status
---

Delegate a smoke-test of this workspace to Copilot and verify it end-to-end.

1. Snapshot state: run `git status --short` so you know the starting point.
2. Delegate ONE task via `mcp__plugin_copilot_cp__delegate` with:
   - `cwd`: current workspace
   - `tier`: 0 (a smoke test should be quick and cheap; use 1 if tier 0 has no selectable model)
   - `autoRetry`: true
   - Task text: "Run a smoke test of this workspace: run the available build/test commands (package.json scripts, Makefile, etc.), check that they pass, and do not change any source file. Write the job report with STATUS COMPLETED if everything passes, PARTIAL if some checks fail, BLOCKED if nothing could run, plus the list of commands run and their outcome. $ARGUMENTS"
3. Supervise with `mcp__plugin_copilot_cp__wait` until idle. On needsInput respond sensibly (approve test/build commands); on `retried` follow `newSessionID`.
4. Verify with `mcp__plugin_copilot_cp__diff {sessionID}` — report what the worker touched (it should be nothing but its report).
5. Report one line: verdict + failing checks (if any) + report path. Never commit anything the worker produced.
