# GitHub Copilot CLI plugin for Claude Code

Use [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) from inside Claude Code: delegate bounded coding tasks to Copilot workers, supervise them live, review your changes with Copilot, and keep an eye on the AI credits it spends.

Claude stays the supervisor. Each delegated job runs in its own `copilot --acp` worker (the Copilot CLI's [Agent Client Protocol](https://agentclientprotocol.com) server), with its own model, reasoning effort and tool rules; Claude shapes the task, answers the permission requests Copilot cannot decide alone, and verifies the result before trusting it.

## What You Get

- **`/copilot:delegate`, `/copilot:parallel`, `/copilot:test`** — hand work to Copilot workers and supervise them through the plugin's MCP tools, with a streamed activity feed (output, reasoning, tool calls, plan) while they run.
- **`/copilot:review`, `/copilot:adversarial-review`** — Copilot reviews your working tree or branch and answers with structured findings.
- **`/copilot:rescue`** — forward a stuck investigation or fix to Copilot, foreground or background, and resume it later.
- **Model tiers over the live Copilot catalog** — tier 0-3 picks from the models your account actually has, with their premium multipliers (0.33x, 1x, 15x…); `/copilot:model` edits the tiers safely.
- **Usage and budgets in AI credits** — every job records the credits and premium requests Copilot billed for it; `/copilot:cost` aggregates them and daily caps can stop new delegations.
- **Optional stop-time review gate** — Copilot reviews Claude's last turn before the session may stop.

## Requirements

- Claude Code
- [GitHub Copilot CLI](https://github.com/github/copilot-cli) with ACP support, on `PATH` as `copilot` (verified with 1.0.102; `doctor` warns on older releases)
- A GitHub account with a Copilot plan, signed in with `copilot login` (or `COPILOT_GITHUB_TOKEN`)
- Node.js 18.18 or later

## Install

Inside Claude Code:

```bash
/plugin marketplace add naicud/copilotcli-plugin-cc
/plugin install copilot@naicud-copilotcli-plugin-cc
/reload-plugins
```

Or with the one-line installer (same result):

```bash
! curl -fsSL https://raw.githubusercontent.com/naicud/copilotcli-plugin-cc/main/install.sh | bash
```

Then check the setup:

```bash
/copilot:setup
```

It reports the CLI version, who Copilot is signed in as, and the default delegation model. If Copilot CLI is missing it offers to install it (`npm install -g @github/copilot`; Homebrew and WinGet packages work too). If you are not signed in, run `! copilot login`. The MCP `doctor` tool goes further: it opens a real ACP session, reads the model catalog, and checks that the default model resolves.

### Uninstall

```bash
/plugin uninstall copilot@naicud-copilotcli-plugin-cc
```

Plugin state lives in Claude Code's plugin data directory (or `/tmp/copilot-companion` when that is not set); delegated workspaces keep their `.cp-reports/` until the hygiene sweep removes old reports.

## Slash Commands

| Command | What it does |
|---|---|
| `/copilot:setup` | Check the CLI, the login and the default model; toggle the review gate (`--enable-review-gate` / `--disable-review-gate`) |
| `/copilot:delegate [--model id] [--tier N] [--effort level] [--reviewer] [--auto-retry] <task>` | Delegate one task and supervise it to a verified result |
| `/copilot:parallel [--race] [flags] <task1> ;; <task2>` | Fan out up to 12 tasks (race mode keeps the first clean finisher) |
| `/copilot:test [extra]` | Delegate a quick build/test smoke run on tier 0 and report what it touched |
| `/copilot:review [--base ref]` | Copilot code review of the working tree or `base...HEAD` |
| `/copilot:adversarial-review [--base ref] [focus]` | Review that challenges the design, with optional focus text |
| `/copilot:rescue [--background\|--wait] [--resume\|--fresh] [--model id] [--effort level] [--read-only] <request>` | Forward an investigation or fix to Copilot through the companion runtime |
| `/copilot:status` · `/copilot:result [job]` · `/copilot:cancel [job]` | Inspect, read and cancel jobs of this workspace |
| `/copilot:logs [job\|session] [lines]` | Activity log of a delegated job |
| `/copilot:cost [--html [path]]` | AI credits and premium requests by day, model and job type, with budget headroom |
| `/copilot:model [list\|tier\|default\|exclude\|include\|effort\|check]` | Edit model tiers, the default model, exclusions and effort |

## Delegation (MCP tools)

The plugin's MCP server is `cp`; Claude Code exposes its tools as `mcp__plugin_copilot_cp__<tool>`.

| Tool | Purpose |
|---|---|
| `models` | Selectable models (tier, multiplier, price category), effort policy, selection hint, today's budget |
| `delegate` | Start a job; returns `sessionID` / `jobId` immediately |
| `fanOut` | Start up to 12 jobs with one model/effort; `mode:"race"` aborts the losers |
| `wait` / `waitAll` | Supervise until `idle`, `needsInput` or `retried`; each call returns a 60 s activity slice (or blocks with MCP progress frames when the client sends a progress token) |
| `status` | Snapshot: current turn, recent tool calls, todos, pending permissions, context usage; without a session, the recent jobs |
| `logs` | The job's activity log: assistant text, reasoning, tool calls, permission decisions, lifecycle |
| `diff` | What the worker changed since the job started (tracked diff + every new file) |
| `respond` | Answer a pending permission: `once`, `always` or `reject` |
| `abort` | Cancel a running job; the Copilot session stays resumable |
| `shutdown` | Stop this plugin's workers (identity-checked), optionally delete finished Copilot sessions and run the hygiene sweep |
| `doctor` | Environment diagnostics, including a live ACP handshake |

### How a delegation runs

1. `delegate` resolves the model (explicit model → tier → configured default) against the live catalog, starts `copilot --acp --stdio --no-ask-user --reasoning-effort <level> --allow-tool=… --deny-tool=…` in your workspace, opens a session, sets the model and sends the first prompt: persona preamble + the work contract from `config/models.json` + your task + the job's report path.
2. While the worker runs, `wait` returns what it is doing: the assistant tail, the reasoning tail, the last tool calls and the todo plan. A `timeout` means *still running*, never failure.
3. Permission requests the configured rules cannot decide come back as `needsInput`; the supervisor answers with `respond`. Rejecting a request ends the worker's current turn, so the hard "never" rules (`git push`, `git commit`, `rm -rf`, `sudo`, …) are passed to Copilot as `--deny-tool` patterns instead: those calls fail inside the worker and it carries on.
4. When the turn ends the worker is closed and the job gets its outcome, response, report, tokens, and the **AI credits / premium requests** Copilot recorded for the session.
5. The supervisor verifies: reads `.cp-reports/<jobId>.md`, checks the listed files with `diff`, re-runs the verification command.

Failures come with an `escalation` hint. With `autoRetry: true` the job is re-delegated once by itself: a rate-limit or quota failure moves one tier up, a lost worker or upstream error retries the same model (bounded by `retryPolicy.maxAutoRetries`). A builder turn that ends with no output at all is nudged once before it counts as failed.

### Personas

- **builder** (default) — may edit the workspace (`--allow-tool=write`).
- **reviewer** — gets no write grant; every edit request is rejected except the job's own report file.

### Workers and sessions

Workers are child processes of the MCP server and stop with it. Their Copilot sessions persist in Copilot's own store (`~/.copilot/session-state/`), so a job interrupted by a restart reports `WorkerLost` and can be continued with `delegate {resumeSessionID}` — the new worker reloads the conversation. Each worker is a full Copilot CLI process; `concurrency.maxDelegates` (default 6) caps how many run at once.

## Models and Effort

`config/models.json` defines four tiers as ordered model preferences:

| Tier | Use | Shipped preferences |
|---|---|---|
| 0 | cheap mechanical work | `claude-haiku-4.5` (0.33x) |
| 1 | **default**: features, fixes, tests | `claude-sonnet-5.5`, `gpt-6-sol`, `gpt-5.6-terra`, `claude-sonnet-5` |
| 2 | hard refactors and debugging | `gpt-6-astra`, `gpt-5.6-sol` |
| 3 | premium multiplier, last resort | `claude-opus-5.5` (15x) |

At delegation time the tier's first model that your account has enabled wins; models the config does not mention are still selectable and tiered from their multiplier (sub-1x → 0, above 1x → 3). The live catalog comes from Copilot itself and is cached for a few hours (`models {refresh: true}` or `/copilot:model list --refresh` re-reads it).

Reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`) comes from `effortPolicy` — per model, per tier, then the default (`high`; tier 0 `medium`, tier 3 `max`) — unless a delegation passes `effort` (`off` leaves the model's own default).

Change any of this with `/copilot:model` rather than by hand; every edit is validated before it is written.

## Usage and Budget

Copilot bills in AI credits and counts premium requests. The CLI records both per session; the plugin copies each job's share onto the job record (cumulative session totals before vs after the job, so resumed sessions are not double counted). `/copilot:cost` aggregates them by day, model and job type, and can write a standalone HTML dashboard.

Daily caps, checked before a delegation starts:

```json
"budget": { "maxDailyCredits": 50, "maxDailyPremiumRequests": 100 }
```

`null` disables a cap.

## Hooks

- **Delegation router** (`PreToolUse` on `Task`/`Agent`) — flags heavy subagent tasks as candidates for Copilot delegation, with a ready delegate/wait recipe.
- **Delegation context** (`PostToolUse` on `wait`/`waitAll`/`status`) — turns a finished, failed, retried or blocked job into a short instruction for Claude.
- **Stop review gate** (`Stop`, off by default) — when enabled with `/copilot:setup --enable-review-gate`, a read-only Copilot review of Claude's last turn runs before the session stops; a `BLOCK` verdict keeps Claude working. It runs at most once per stop.
- **Session end** — settles jobs whose worker is gone and runs the hygiene sweep.

## Disk Hygiene

Nothing is left behind by default: state lives under the plugin data directory, the activity log is in memory (with a small snapshot for restarts), and a TTL sweep runs at server start, hourly, and at session end. It removes workspace state untouched for 14 days (`CP_STATE_TTL_DAYS`, `0` disables) and consumed reports older than 7 days (`CP_REPORT_TTL_DAYS`), only in workspaces this plugin delegated in, never while a job there is running. The catalog probe removes the empty Copilot session it opens. `shutdown {deleteSessions: true}` additionally deletes the Copilot session records of finished delegations.

## Configuration Reference

| Variable | Effect |
|---|---|
| `CP_COPILOT_BIN` | Path to the Copilot CLI (a `.mjs`/`.js` path runs under node — the test suite's fake agent uses this) |
| `CP_MODELS_CONFIG` | Alternative `models.json` |
| `CP_STATE_DIR` | State root (default: Claude Code's plugin data dir, else `/tmp/copilot-companion`) |
| `CP_WAIT_SLICE_SEC` | Length of one `wait` activity slice without a progress token (default 60) |
| `CP_PROGRESS_INTERVAL_MS` | Interval between MCP progress frames (default 8000) |
| `CP_ACTIVITY_LOG=1` | Mirror each job's activity log to a file under the state dir |
| `CP_STATE_TTL_DAYS`, `CP_REPORT_TTL_DAYS` | Hygiene TTLs |
| `COPILOT_HOME` | Copilot's own config/session directory (honoured when reading usage) |

## Testing

```bash
npm test          # unit + end-to-end flows against a fake ACP agent — no credits used
npm run test:e2e  # one live delegation against the real Copilot CLI (uses a few credits)
```

The fake agent (`tests/fixtures/fake-copilot.mjs`) speaks the same ACP subset as the CLI and is scripted by `FAKE:` directives in the prompt, so permission asks, denials, cancellation, crashes, empty turns, retries and usage accounting are all exercised by real worker processes. The protocol facts it mimics are recorded in [`docs/copilot-acp-findings.md`](docs/copilot-acp-findings.md).

## Limitations

- Copilot CLI's ACP server is in public preview; behaviour may change between CLI releases.
- Workers do not survive their MCP server (the session does — resume it).
- `respond {response: "reject"}` ends the worker's turn: that is how the CLI handles a rejection.
- Windows is covered by the fake-agent suite in CI but has not been exercised against the real CLI.

## Ownership & Upstream

Forked from [opencode-plugin-cc](https://github.com/naicud/opencode-plugin-cc), which derives from OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc). The OpenCode backend is replaced by GitHub Copilot CLI over ACP; supervision, the report contract, hooks, hygiene and the companion architecture carry over. See [NOTICE](NOTICE).

## License

Apache-2.0 — see [LICENSE](LICENSE).
