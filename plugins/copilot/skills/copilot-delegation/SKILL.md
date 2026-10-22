---
name: copilot-delegation
description: Criteria for choosing the model tier and structuring tasks when delegating work to GitHub Copilot CLI workers
user-invocable: false
---

# Copilot Delegation Guide

Use this skill when handing a task to a GitHub Copilot CLI worker through the `delegate` MCP tool.

## Tier Selection

Tiers come from `config/models.json`, merged with the models the signed-in Copilot account can
actually use (call `models` to see them with their premium multipliers).

| Tier | Use | Typical multiplier |
|---|---|---|
| 0 | Cheap mechanical work: renames, formatting, boilerplate, simple tests | below 1x |
| 1 | **Default**: features, bug fixes, tests, focused refactors | 1x |
| 2 | Hard multi-file refactors and debugging | 1x (high-end models) |
| 3 | Architecture, last-resort escalation | premium (e.g. 15x) |

Rules:

- Omit `tier`/`model` to get the configured default. When unsure between two tiers, take the LOWER one.
- Retry at most once, and only one tier higher. Never jump to tier 3 unless the user asked for it or tier 2 already failed.
- Excluded models (config/models.json `excluded`, or not enabled for the account) are not selectable.

## Effort

- The effort policy picks a reasoning effort per tier (low | medium | high | xhigh | max).
- Override with `effort` only when the task clearly needs it: `xhigh`/`max` for subtle debugging, `low` for trivial edits. Higher effort is slower and uses more credits.

## Task Structure

A delegable task contains, in order:

1. **Goal** — one sentence, outcome-focused.
2. **Scope** — files in scope as explicit paths; call out out-of-scope areas.
3. **Acceptance criteria** — verifiable statements ("`npm test` passes", "endpoint returns 200").
4. **Verification command** — a concrete command that proves completion.

The work contract (config/models.json) is prepended automatically: it restricts work to the
workspace, forbids commits/pushes, and requires a per-job report at `.cp-reports/<jobId>.md` with
STATUS + files list.

## Supervision Loop

- `delegate` → save sessionID/jobId
- `wait` until idle / needsInput / retried (one 60s activity slice per call, chained); for parallel
  fan-outs use `waitAll` with up to 12 sessionIDs
- LONG-HORIZON: a `timeout` result is NOT a failure — the worker is still running. Re-issue
  `wait`/`waitAll` for as long as needed; only the USER may order a kill (`abort`).
- `logs {sessionID}` tails the job's activity log — streamed reasoning, assistant output, tool
  calls, permission decisions, lifecycle transitions
- `needsInput`: approve only safe read/test commands (`respond once`); reject git push/commit,
  rm -rf, sudo, curl-to-shell (a reject ends the worker's turn)
- `retried`: the job failed and was re-delegated (autoRetry) — continue with `newSessionID`
- terminal error (non-retryable) → report FAILED with the escalation object
- blast-radius check → `diff {sessionID}` (tracked diff + untracked files since the job's `gitBase` snapshot)
- done supervising → `shutdown` stops this plugin's workers cleanly (running turns cancelled,
  only identity-verified pids killed, jobs marked cancelled; `all: true` covers every workspace)
- failed with a retryable error → follow the `escalation` object: re-delegate at `suggestModel`,
  passing `retryOf: <failed jobId>`
- `WorkerLost` (the MCP server restarted mid-job) → re-delegate with `resumeSessionID: <sessionID>`
  to continue the same Copilot conversation
- verify the report AND the listed files yourself before trusting success

## Anti-patterns

- Delegating vague asks without acceptance criteria
- Trusting the worker's report without checking files/tests
- Retrying repeatedly at the same tier instead of escalating once or stopping
- Spending tier 3 (premium multiplier) on work tier 1 can finish
