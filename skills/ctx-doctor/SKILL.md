---
name: ctx-doctor
description: "Run context-mode diagnostics and display results."
user-invocable: true
---

# Context Mode Doctor

Run diagnostics and display results directly in the conversation. Trigger: `/context-mode:ctx-doctor`

## Instructions

1. Call the `ctx_doctor` MCP tool directly. It runs all checks server-side and returns a markdown checklist.
2. Display the results verbatim — they are already formatted as a checklist with `[x]` PASS, `[ ]` FAIL, `[-]` WARN.
3. **Fallback** (only if MCP tool call fails): Derive the **plugin root** from this skill's base directory (go up 2 levels — remove `/skills/ctx-doctor`), then run with Bash:
   ```
   CLI="<PLUGIN_ROOT>/cli.bundle.mjs"; [ ! -f "$CLI" ] && CLI="<PLUGIN_ROOT>/build/cli.js"; node "$CLI" doctor
   ```
   Re-display results as a markdown checklist.
