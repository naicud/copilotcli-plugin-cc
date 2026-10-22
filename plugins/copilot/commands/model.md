---
description: Guided wizard to list Copilot models, move them between tiers, set the default model, exclude models and set reasoning effort
argument-hint: '[list|tier|default|exclude|include|effort|check] [args]'
disable-model-invocation: false
allowed-tools: Bash(node:*), mcp__plugin_copilot_cp__models
---

Guide the user through model configuration. Never edit `config/models.json` by hand — every
mutation goes through the companion so the config stays valid.

Arguments: `$ARGUMENTS` — if they already name an operation (e.g. `tier claude-haiku-5.5 0`), run
it directly and skip the interview.

## Step 1 — Show the current catalog

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" model list
```

Add `--refresh` when the user says a model is missing (the catalog is cached for a few hours). Each
row shows tier, model id, premium multiplier (0.33x, 1x, 15x, …) and Copilot's price category.
Models marked `auto-tiered` are not in `config/models.json`; their tier is guessed from the
multiplier.

## Step 2 — Interview the user

Ask what they want:

1. **Which model** — an id from `model list` (only models the account has enabled can be used).
2. **What role** → tier:
   - Tier 0 — cheap mechanical work (sub-1x multiplier)
   - Tier 1 — the default: features, fixes, tests
   - Tier 2 — hard refactors / debugging
   - Tier 3 — premium multiplier, last resort
3. **Reasoning effort** — low | medium | high | xhigh | max, globally, per tier or per model.
   Higher effort is slower and uses more credits.

## Step 3 — Apply ONE mutation

```bash
# put a model first in a tier (removes it from any other tier)
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" model tier <id> <0-3>

# default model for delegations without --model/--tier (or --clear to fall back to the default tier)
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" model default <id>

# never select a model / allow it again
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" model exclude <id> [reason]
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" model include <id>

# reasoning effort: global | one tier | one model (off clears that scope)
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" model effort global high
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" model effort tier:2 xhigh
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" model effort model:<id> max
```

If the command exits non-zero it prints `ERROR <code>: reason`. Explain the code to the user and
retry with corrected arguments — do not fall back to hand-editing the file.

## Step 4 — Verify

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" model check && \
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" model list
```

Show the resulting row(s).
