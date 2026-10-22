---
description: Delegate a task to a GitHub Copilot CLI worker with model/tier/effort control and supervise it
argument-hint: '[--model <id>] [--tier N] [--effort low|medium|high|xhigh|max|off] [--reviewer] [--auto-retry] <task>'
allowed-tools: Bash(node:*), mcp__plugin_copilot_cp__models, mcp__plugin_copilot_cp__delegate, mcp__plugin_copilot_cp__wait, mcp__plugin_copilot_cp__waitAll, mcp__plugin_copilot_cp__status, mcp__plugin_copilot_cp__logs, mcp__plugin_copilot_cp__respond, mcp__plugin_copilot_cp__abort, mcp__plugin_copilot_cp__shutdown, mcp__plugin_copilot_cp__doctor, mcp__plugin_copilot_cp__diff
---

Delegate the following task through the Copilot MCP tools.

Parse routing flags from $ARGUMENTS and strip them from the task text:

- `--model <id>` → explicit Copilot model id for the `delegate` call
- `--tier N` → tier selection (0–3) when no explicit model
- `--effort low|medium|high|xhigh|max|off` → reasoning effort (`off` = the model's own default)
- `--reviewer` → `persona: "reviewer"` (read-only worker that only writes its report)
- `--retry <job-id-prefix>` → link this run to a previously failed/cancelled job (`retryOf`)
- `--resume <sessionID>` → continue an existing Copilot session instead of starting a new one
- `--auto-retry` → on a retryable failure re-delegate once automatically (`wait` returns `status:"retried"`)

Procedure:

1. Call `models` with `{cwd}` to see the tiers, premium multipliers and today's budget. Pick a tier by task difficulty; never move to tier 3 (premium multiplier) unless the user asked for it or a lower tier already failed.
2. Call `delegate` with `{task: <stripped task text>, cwd, ...flags}`. Map `--retry` / `--resume` / `--auto-retry` / `--reviewer` to `retryOf` / `resumeSessionID` / `autoRetry: true` / `persona: "reviewer"`.
3. Call `wait` with `{sessionID, cwd}` in a loop until it returns `idle`, `needsInput` or `retried`. Each call returns within one 60s slice with a fresh activity snapshot (assistant tail, reasoning, recent tool calls, todos) — chain the calls without an explicit timeoutSec so progress streams into the conversation like a subagent transcript.
4. On `needsInput`, decide each permission: approve read-only/test commands with `respond {response:"once"}`; reject anything matching git push/commit, rm -rf, sudo, or curl piped to a shell (a reject ends the worker's turn), then report blocked.
5. On `retried`, keep supervising `newSessionID`.
6. Verify per the delegation contract: read the job report (`report.path` in the idle result, under `.cp-reports/`), check the listed files exist, cross-check with `diff {sessionID}`, and re-run read-only verification commands if given.
7. Report STATUS (your judgment), changed files, verification performed, model, effort and the AI credits the job used.

Keep chaining `wait` calls for as long as the task runs — timeouts are supervision events, never failures. `abort` ONLY on an explicit user request to kill the task. If a final `wait` carried an `escalation` object with `retryable: true`, re-delegate once with `suggestModel` and `--retry <failed jobId>`.
