# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-22

First release: GitHub Copilot CLI as the delegation worker for Claude Code,
forked from opencode-plugin-cc with the OpenCode backend replaced.

### Added

- MCP server `cp` with twelve tools — `models`, `delegate`, `fanOut`, `wait`,
  `waitAll`, `status`, `logs`, `diff`, `respond`, `abort`, `shutdown`,
  `doctor` — exposed to Claude Code as `mcp__plugin_copilot_cp__<tool>`.
- Every delegated job runs in its own `copilot --acp --stdio` worker: per-job
  model (`session/set_model`), reasoning effort (`--reasoning-effort`) and tool
  rules (`--allow-tool` / `--deny-tool`). Streaming output, reasoning, tool
  calls and plan updates feed `wait` snapshots, MCP progress frames and `logs`.
- Permission supervision: requests the configured rules do not decide surface
  as `needsInput`; `respond` answers once / always / reject.
- Model tiers 0-3 from `config/models.json`, merged with the live catalog the
  signed-in account advertises (premium multiplier, price category,
  enablement); models the config does not list are tiered from their
  multiplier. The catalog is cached and refreshed by every worker.
- Builder and reviewer personas; the reviewer has no write grant and may only
  write its own report.
- Per-job report contract (`.cp-reports/<jobId>.md`), delivered once in the
  idle `wait` result.
- Auto-retry with escalation (rate limit → next tier; worker loss / upstream
  error → same model), a one-shot nudge for empty builder turns, and
  `resumeSessionID` to continue a Copilot session in a new worker
  (`session/load`).
- `fanOut` batch and race modes; `waitAll` with early exit.
- Usage accounting in AI credits and premium requests per job, read from the
  session's own event log; daily budget caps (`maxDailyCredits`,
  `maxDailyPremiumRequests`).
- Slash commands: `/copilot:setup`, `/copilot:delegate`, `/copilot:parallel`,
  `/copilot:test`, `/copilot:review`, `/copilot:adversarial-review`,
  `/copilot:rescue`, `/copilot:status`, `/copilot:result`, `/copilot:cancel`,
  `/copilot:logs`, `/copilot:cost`, `/copilot:model`.
- `copilot-delegate` and `copilot-rescue` subagents and the
  delegation/prompting/result-handling/routing/runtime/supervision skills.
- Hooks: delegation router on `Task`/`Agent`, delegation context after
  `wait`/`waitAll`/`status`, optional stop-time review gate, SessionEnd
  settling of jobs whose worker is gone plus the disk hygiene sweep.
- Test suite driven by a fake ACP agent (no credits used), and
  `npm run test:e2e` for a live round trip against the real CLI.

### Fixed (relative to the fork's starting point)

- The stop review gate now blocks with Claude Code's `{"decision":"block"}`
  output; the inherited gate exited with code 1, which Claude Code reports as
  a hook error without blocking.
- `diff` lists every new file instead of collapsing a new directory into
  `dir/`.
