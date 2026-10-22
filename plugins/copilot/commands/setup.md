---
description: Check whether the local GitHub Copilot CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), Bash(brew:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup --json $ARGUMENTS
```

If the result says Copilot CLI is not installed:
- Use `AskUserQuestion` exactly once to ask whether Claude should install it now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Copilot CLI (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @github/copilot
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup --json $ARGUMENTS
```

If Copilot CLI is already installed:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Copilot CLI is installed but `auth` shows no login, tell the user to run `!copilot login` (an interactive browser login), or to export `COPILOT_GITHUB_TOKEN` with a fine-grained token that has the Copilot Requests permission.
- For a deeper check (ACP handshake, model catalog, default model), suggest the MCP `doctor` tool.
