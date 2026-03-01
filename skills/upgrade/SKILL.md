---
name: upgrade
description: |
  Update context-mode from GitHub and fix hooks/settings.
  Pulls latest, builds, installs, updates npm global, configures hooks.
  Trigger: /context-mode:upgrade
user_invocable: true
---

# Context Mode Upgrade

Pull latest from GitHub and reinstall the plugin.

## Instructions

1. Derive the **plugin root** from this skill's base directory (go up 2 levels — remove `/skills/upgrade`).
2. Run with Bash:
   ```
   node "<PLUGIN_ROOT>/build/cli.js" upgrade
   ```
3. **Registry verification** (CRITICAL — do this even if upgrade reported success):
   Run a Bash command that does ALL of the following in a single `node -e` script:
   - Read `~/.claude/plugins/installed_plugins.json`
   - Find the `context-mode@claude-context-mode` entry (or any key containing `context-mode`)
   - List directories in `~/.claude/plugins/cache/claude-context-mode/context-mode/`
   - Find the newest semver directory (e.g., `0.9.9` > `0.7.0`)
   - If `installPath` does NOT already point to the newest directory, update:
     - `installPath` → full path to newest version dir
     - `version` → the newest version string
     - `lastUpdated` → `new Date().toISOString()`
   - Write updated JSON back to the file
   - Print what was changed (or "already correct")

4. **IMPORTANT**: After the Bash tool completes, re-display the key results as markdown text directly in the conversation so the user sees them without expanding the tool output. Format as:
   ```
   ## context-mode upgrade
   - [x] Pulled latest from GitHub
   - [x] Built and installed v0.9.9
   - [x] npm global updated
   - [x] Hooks configured
   - [x] Permissions set
   - [x] Registry verified
   - [x] Doctor: all checks PASS
   ```
   Use `[x]` for success, `[ ]` for failure. Show the actual version numbers and any warnings.
   Tell the user to **restart their Claude Code session** to pick up the new version.
