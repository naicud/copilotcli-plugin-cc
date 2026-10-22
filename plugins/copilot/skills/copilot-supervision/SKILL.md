---
name: copilot-supervision
description: Supervise a task delegated to a GitHub Copilot CLI worker end to end — pick the model, run the delegate/wait loop, answer permission asks, and verify the result against the job report contract before trusting it. Use when the user EXPLICITLY asks for delegation, a subagent, a Copilot worker or fan-out work; never start it proactively, and never for routine single-file edits, exploration or quick questions.
user-invocable: true
---

# Copilot Supervision

You are the supervisor of a delegated run. You never write the code yourself:
you shape the task, pick the model, run the `delegate`/`wait` loop, answer
permission asks, and verify what comes back.

Tool names are the `cp` MCP server's, unprefixed here; Claude Code exposes
them as `mcp__plugin_copilot_cp__<tool>`.

## 0. Where the supervision runs

Prefer spawning the `copilot:copilot-delegate` subagent — it already carries
this protocol and keeps the loop out of the main thread's context. Run the
loop below inline only when a subagent is not an option.

The worker runs in the caller's working directory — there is no worktree
isolation. Pass that `cwd` to every tool call, scope the task with explicit
in/out-of-scope paths, and never create or switch git worktrees.

## 1. Choose the model

- Call `models` first (pass `cwd`) and read the tiers, premium multipliers and
  today's budget.
- Tier 0 = cheap mechanical work (sub-1x), tier 1 = the default, tier 2 = hard
  refactors/debugging, tier 3 = premium multiplier (only when asked for, or
  after tier 2 failed).
- When torn between two tiers, take the lower one.

## 2. Write the task

Before delegating, the task text must contain:

1. The goal in one sentence.
2. Files in scope (explicit paths) and anything explicitly out of scope.
3. Verifiable acceptance criteria.
4. A concrete test or verification command that proves completion.

Do not delegate vague asks ("fix the tests", "clean this up"). Tighten them
first using the `copilot-prompting` conventions.

## 3. Run the loop

- Call `delegate` with `{task, cwd}`, adding `model`, `tier` or `effort` only
  when justified. Save `sessionID` and `jobId`. Use `persona: "reviewer"` for
  read-only reviews. Pass `skills: [...]` when the task needs extra
  conventions — their digests reach the worker prompt.
- Call `logs {sessionID}` whenever you need to see what the worker is doing
  right now: streamed reasoning, assistant output, tool calls, permissions.
- To re-run a failed or cancelled job pass `retryOf: <jobId>`, so the retry is
  linked in job history. To continue an interrupted session pass
  `resumeSessionID: <sessionID>` instead of starting fresh.
- Call `wait {sessionID, cwd}` repeatedly until it returns something other than
  `timeout`.
- LONG-HORIZON RULE: `timeout` NEVER means failure — the worker keeps running.
  Keep calling `wait` for as long as the task needs. Only the USER decides to
  kill a run: call `abort` exclusively on an explicit user request or on a
  terminal error. Never abort on a timeout.
- On `retried`, the job failed and was re-delegated automatically: continue
  with `newSessionID`.
- On `needsInput`, read every entry in `permissions`: answer
  `respond {response: "once"}` ONLY when the command is clearly safe and inside
  the workspace (reads, test runs, package installs). Anything touching
  `git push`/`git commit`, `rm -rf`, `sudo`, or piping `curl` into a shell must
  be answered `reject` (which ends the worker's turn), then reported as BLOCKED.
- Use `status` sparingly to inspect the current turn, todos and pending
  permissions mid-flight.

## 4. Verify (mandatory)

Never trust the worker's own report alone:

1. Wait until status is idle.
2. Read the report the job wrote — `report.path` in the idle result
   (`.cp-reports/<jobId>.md`). STATUS must be COMPLETED, PARTIAL or BLOCKED,
   with a `files` list.
3. Check that every file in `files` exists and was plausibly modified.
   Cross-check the real change set with `diff {sessionID}`.
4. Re-run the task's verification command yourself when one was specified and
   it is read-only.

If the report claims success but files are missing or tests fail, the run is
FAILED regardless of what the report says.

## 5. Report back

State explicitly:

- `STATUS: COMPLETED | PARTIAL | BLOCKED | FAILED` — your judgment, not the
  worker's claim repeated.
- What was done and which files changed.
- How you verified it.
- If BLOCKED: the exact blocker text from the permission or report, with
  nothing invented.
- Which model ran, its effort, and the AI credits the job used.

Retry policy: at most ONE retry per task, and only one tier above the failed
attempt. When a failed `wait` returned an `escalation` object, follow it —
re-delegate with `suggestModel` and `retryOf` pointing at the failed job.
