---
name: doctor
description: |
  Run context-mode diagnostics. Checks runtimes, hooks, FTS5,
  plugin registration, npm and marketplace versions.
  Trigger: /context-mode:doctor
user_invocable: true
---

# Context Mode Doctor

Run diagnostics and display results directly in the conversation.

## Instructions

1. Derive the **plugin root** from this skill's base directory (go up 2 levels — remove `/skills/doctor`).
2. Run with Bash:
   ```
   node "<PLUGIN_ROOT>/build/cli.js" doctor
   ```
3. **IMPORTANT**: After the Bash tool completes, re-display the key results as markdown text directly in the conversation so the user sees them without expanding the tool output. Format as a checklist:
   ```
   ## context-mode doctor
   - [x] Runtimes: 6/10 (javascript, typescript, python, shell, ruby, perl)
   - [x] Performance: FAST (Bun)
   - [x] Server test: PASS
   - [x] Hooks: PASS
   - [x] FTS5: PASS
   - [x] npm: v0.7.0
   - [x] Marketplace: v0.7.0
   ```
   Use `[x]` for PASS, `[ ]` for FAIL, `[-]` for WARN.
