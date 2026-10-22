---
description: Fan out MULTIPLE tasks in parallel to Copilot CLI workers and supervise the batch
argument-hint: '[--race] [--tier N] [--model <id>] [--effort low|medium|high|xhigh|max|off] <task1> ;; <task2> ;; <task3>'
allowed-tools: Bash(node:*), mcp__plugin_copilot_cp__models, mcp__plugin_copilot_cp__fanOut, mcp__plugin_copilot_cp__waitAll, mcp__plugin_copilot_cp__wait, mcp__plugin_copilot_cp__status, mcp__plugin_copilot_cp__logs, mcp__plugin_copilot_cp__respond, mcp__plugin_copilot_cp__abort, mcp__plugin_copilot_cp__shutdown, mcp__plugin_copilot_cp__doctor, mcp__plugin_copilot_cp__diff, mcp__plugin_copilot_cp__delegate
---

Fan out multiple tasks to Copilot in parallel through the MCP tools.

Split $ARGUMENTS into individual tasks: separate them with `;;` (or one per list item).
Parse and strip routing flags (same meaning as `/copilot:delegate`):

- `--tier N` → tier for the whole batch (0–3)
- `--model <id>` → explicit model id for every task
- `--effort low|medium|high|xhigh|max|off` → reasoning effort for every task
- `--race` → RACE MODE: all tasks should be variants of the SAME goal; `fanOut` runs them with
  `mode:"race"` and the first clean completion wins — the others are aborted automatically so they
  stop consuming credits. Report the winner's response and report.

Every task runs in its own Copilot worker process; each one consumes credits independently.

## Procedure

1. **fanOut** with `tasks: [...]`, the parsed flags, and a short `titlePrefix`.
2. **waitAll** on the returned sessionIDs, re-issued until every session reports idle. On
   `needsInput`, review each pending permission with `respond` — approve only safe read/test
   commands, reject git push/commit, rm -rf, sudo, curl-to-shell.
3. For any session ending in a retryable error, re-delegate it individually via `delegate` with the
   escalation's `suggestModel` and `retryOf: <failed jobId>`.
4. Timeouts on a session mean it is STILL RUNNING — re-issue `waitAll` (or per-session `wait`)
   until idle. `abort` only on an explicit user request to kill that task.
5. **Verify**: read each task's report and expected artifacts yourself; do not trust the report
   alone. Cross-check each session's blast radius with `diff {sessionID}`.
6. Report one line per task: artifact verdict + model + AI credits used.

If more than 12 tasks are given, run fanOut in batches of ≤12 sequentially.
