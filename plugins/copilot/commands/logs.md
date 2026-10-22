---
description: Live activity log of a delegated Copilot job (reasoning, output, tool calls, permissions)
argument-hint: '[jobId|sessionID] [lines]'
disable-model-invocation: true
allowed-tools: mcp__plugin_copilot_cp__logs
---

Call the `logs` MCP tool and show the result.

Arguments: `$ARGUMENTS`

- If the first argument starts with `delegate-`, pass it as `jobId`; any other first argument is a `sessionID`.
- A trailing number is `lines` (default 80, max 400).
- With no arguments, call `logs` with `{}` (the most recent delegate job of this workspace).

Show the returned `lines` verbatim as a code block, preceded by one header line with the job id, status and model.
If the job is still running, add the `live.assistantTail` (and `live.reasoningTail` when present) after the lines.
Do not summarize or interpret the log.
