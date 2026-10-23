# GitHub Copilot CLI over ACP — verified behaviour

What was observed against a real install (`GitHub Copilot CLI 1.0.102`, macOS,
signed-in account) while building this plugin, and the design decision each
finding drives. Everything here was observed with probe clients, not inferred
from documentation. ACP support in the CLI is a public preview, so re-verify
after major CLI upgrades (`npm run test:e2e` covers the happy path).

## Transport and handshake

| Thing | Result |
|---|---|
| Start | `copilot --acp --stdio` — NDJSON JSON-RPC 2.0 on stdin/stdout |
| `initialize` | `protocolVersion: 1`; `agentCapabilities.loadSession: true`, `sessionCapabilities: {close, list}`, `promptCapabilities.image: true` |
| Lifecycle | The process exits when its stdin closes |
| Auth | Reuses the CLI login (`copilot login`) or `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` |

## Sessions

- `session/new {cwd, mcpServers: []}` returns `sessionId`, `models`
  (`availableModels`, `currentModelId`), `modes` and `configOptions`
  (`mode`, `model`, `reasoning_effort`, `allow_all`).
- `availableModels[]._meta` carries `copilotUsage` (premium multiplier:
  `"0.33x"`, `"1x"`, `"15x"`, `"30x"`), `copilotPriceCategory`
  (`low`…`very_high`) and `copilotEnablement`. This is the live catalog the
  plugin tiers against; `auto` is a pseudo-model and is skipped.
- `session/set_model {sessionId, modelId}` works; an unknown id fails with
  `-32602 Invalid modelId '<id>': not one of this session's models.` — used to
  fail a delegation fast with the list of usable models.
- `session/load {sessionId, cwd, mcpServers}` in a **new process** reopens a
  stored session and replays its history as `session/update` notifications
  before answering. That is how `delegate {resumeSessionID}` and
  `/copilot:rescue --resume` continue earlier work.
- Opening a session writes `~/.copilot/session-state/<id>/` even if no prompt
  is ever sent. The catalog probe deletes that directory again (only when it
  holds no `events.jsonl`).

## Turns

- `session/prompt` resolves when the turn ends with
  `{stopReason, usage: {inputTokens, outputTokens, thoughtTokens, cachedReadTokens, cachedWriteTokens}}`.
- Streamed `session/update` kinds seen: `agent_message_chunk`,
  `agent_thought_chunk` (with `--reasoning-effort high` and up), `tool_call`
  (`kind: edit | execute | read …`, `rawInput`), `tool_call_update`
  (`status: completed | failed`, `rawOutput`), `plan`, `usage_update`
  (context window `used/size`), `session_info_update`,
  `available_commands_update`, `config_option_update`.
- `session/cancel` (a notification) makes the pending `session/prompt` resolve
  with `stopReason: "cancelled"`; the session stays resumable.
- A 130 s tool call and multi-minute turns complete normally; there is no
  per-turn timeout on the ACP side.

## Permissions

- Edits and shell commands arrive as `session/request_permission`
  (agent → client request) with options `allow_once`, `allow_always`,
  `reject_once`; the answer is `{outcome: {outcome: "selected", optionId}}`.
- **Rejecting ends the worker's turn** (`tool_call_update` failed with
  `code: "rejected"`, then "Operation cancelled by user"). Hard "never do
  this" rules therefore go in `--deny-tool` instead: a denied call fails with
  `code: "denied"` and the model carries on with the rest of the task.
- `--allow-tool=write` pre-approves file edits; `--allow-tool` /
  `--deny-tool` patterns such as `shell(git push)` match the command prefix.
  These flags, `--reasoning-effort` and `--no-ask-user` apply to the whole ACP
  process — the reason the plugin runs one process per job.

## Usage accounting

- Each session's `events.jsonl` gets a `session.usage_checkpoint` after every
  turn (`totalNanoAiu`, `totalPremiumRequests`) and a `session.shutdown` with
  an `accountingSnapshot` when the process exits. 1 AI credit = 1e9 nano-AIU.
- The totals are cumulative across `session/load`: a resumed session went
  from 430678000 nano-AIU / 1 request to 463265500 / 2. Job usage is therefore
  the difference between the totals before and after the job.

## Measured

| Run | Model | Result |
|---|---|---|
| Live e2e: write `src/sum.js` + a node:test, run `npm test`, write the report | claude-haiku-4.5, effort low | completed in one turn, one permission ask (`mkdir -p`), 6.01 AI credits / 0.33 premium requests |
| `/copilot:review` of a two-bug diff | claude-haiku-4.5, effort low | both bugs found, schema-valid JSON, 1.84 AI credits |
| Live e2e (same task) | claude-haiku-5.5, effort low | completed, one permission ask, 0.77 AI credits / 1 premium request |
| README demo: `src/slugify.js` + 3 node:test cases | claude-haiku-5.5, effort medium | completed, 3/3 tests, 0.56 AI credits / 1 premium request |
