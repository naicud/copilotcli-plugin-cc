---
name: copilot-result-handling
description: Guidance for interpreting and presenting Copilot task results
user-invocable: false
---

# Copilot Result Handling

## Result Structure

Every Copilot run (MCP delegation or companion job) is one Copilot CLI session. What comes back:
- **Response**: the worker's final assistant message for the turn
- **Report**: for delegations, the per-job report `.cp-reports/<jobId>.md` (STATUS on the first line, a `files` list)
- **Tool calls**: the recent tool invocations (shell commands, edits, reads) with their final status
- **Outcome**: completed, failed (with an error and, when retryable, an escalation hint) or cancelled
- **Usage**: AI credits and premium requests the session consumed, read from Copilot's own accounting

## Presenting Results

When displaying results from `/copilot:result` or a finished `wait`:
1. Show the job id and the Copilot session id for reference
2. Present the final response (or the report, for delegations) as the primary output
3. If files changed, summarize which ones — `diff {sessionID}` is the ground truth, not the report
4. Include the outcome and the credits used

## Resuming Sessions

Copilot sessions persist in Copilot's session store and can be continued from a new worker:
- delegations: `delegate {task, resumeSessionID}` continues the same conversation;
- rescue tasks: `/copilot:rescue --resume` (the companion's `--resume-last`) reuses the last task session of this Claude session.
