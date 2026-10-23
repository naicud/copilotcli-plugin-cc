---
name: copilot-prompting
description: Best practices for crafting effective prompts when delegating tasks to Copilot
user-invocable: false
---

# Copilot Prompting Guide

Use this skill to shape prompts before forwarding to the Copilot companion runtime.

## Prompt Structure

A good Copilot task prompt should:
1. **State the goal clearly** -- What should be accomplished?
2. **Provide context** -- What files, functions, or systems are involved?
3. **Define success criteria** -- How do we know it's done?
4. **Set constraints** -- What should NOT be changed?

## Write vs read-only

- Rescue tasks (`/copilot:rescue`) are write-capable by default; add `--read-only` for investigation, diagnosis or research that must not edit files.
- MCP delegations run as a **builder** (may edit the workspace) unless `persona: "reviewer"` is passed — a read-only worker that may only write its report.
- Never rely on the prompt alone to keep a worker read-only: pick the read-only mode, which is enforced by the worker's tool rules.

## Best Practices

- Be specific about file paths and function names when possible
- Include error messages or test failures verbatim
- Specify the programming language and framework context
- If debugging, include reproduction steps
- For refactoring, describe the desired end state

## Anti-patterns

- Do not ask Copilot to "fix everything" without specifics
- Do not include irrelevant context that dilutes the prompt
- Do not ask for multiple unrelated tasks in one prompt
- Do not assume Copilot knows your project's conventions without telling it
