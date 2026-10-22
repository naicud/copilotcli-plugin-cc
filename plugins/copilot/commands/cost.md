---
description: Show Copilot usage (AI credits and premium requests, today, by model/day) and budget headroom
argument-hint: "[--html [path]]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the cost command and return output verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" cost $ARGUMENTS
```

- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
