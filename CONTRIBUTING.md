# Contributing to context-mode

This project is licensed under the Elastic License 2.0 (ELv2) and moves forward with your support. Every issue, every PR, every idea matters.

Don't overthink it. Don't ask yourself "is my PR good enough?" or "is this issue too small?" -- just send it. A rough draft beats a perfect plan that never ships. If you found a bug, report it. If you have an idea, open an issue. If you wrote a fix, submit the PR.

That said, I'm a solo maintainer with limited time. The best way to help me help you: follow the templates, include your `/context-mode:doctor` output, and write tests for your changes. The more context you give me, the faster I can review.

I genuinely love open source and I'm grateful to have you here. Don't hesitate to reach out -- whether it's a question, a suggestion, or just to say hi. Let's build this together.

---

This guide covers the local development workflow so you can test changes in a live Claude Code session before submitting a PR.

## Architecture Overview

context-mode uses a flat `src/` structure:

```
src/
  server.ts        → MCP server, tool handlers, auto-indexing
  store.ts         → FTS5 content store (index, search, chunking)
  executor.ts      → Polyglot code executor (11 languages)
  security.ts      → Permission enforcement (deny/allow rules)
  runtime.ts       → Runtime detection (Node, Bun, Python, etc.)
  db-base.ts       → SQLite base class (shared by store + session)
  truncate.ts      → Smart output truncation
  cli.ts           → CLI commands (setup, doctor)
  types.ts         → Shared type definitions
  session/
    db.ts          → SessionDB — persistent event storage
    extract.ts     → Event extractors for PostToolUse hook
    snapshot.ts    → Resume snapshot builder (priority tiers)
  adapters/
    types.ts       → HookAdapter interface, RoutingInstructionsConfig
    detect.ts      → Platform detection via env vars
    claude-code/   → Claude Code adapter (index.ts, hooks.ts, config.ts)
    gemini-cli/    → Gemini CLI adapter
    opencode/      → OpenCode adapter
    codex/         → Codex CLI adapter
    vscode-copilot/ → VS Code Copilot adapter
  openclaw/
    workspace-router.ts → Workspace path resolution for Pi Agent sessions
  openclaw-plugin.ts   → OpenClaw gateway plugin entry (sync register)
hooks/               → Plain JS hooks (.mjs) — no build needed
configs/             → Per-platform install files (settings.json, mcp.json, CLAUDE.md, etc.)
```

`tsc` compiles `src/` → `build/`. `start.mjs` loads `server.bundle.mjs` (CI-built) if present, otherwise falls back to `build/server.js`.

> **Critical for local dev:** Delete `server.bundle.mjs` in your local clone or your `build/server.js` changes will never be loaded:
> ```bash
> rm server.bundle.mjs  # forces start.mjs to use build/server.js
> ```

### Session Continuity Architecture

Session events flow through a two-database system:

1. **SessionDB** (persistent, per-project): `~/.claude/context-mode/sessions/<hash>.db`
   - PostToolUse hook captures events in real-time
   - PreCompact hook builds resume snapshots
   - UserPromptSubmit hook captures user prompts

2. **ContentStore** (ephemeral, per-process): `/tmp/context-mode-<PID>.db`
   - FTS5 full-text search index for tool outputs
   - Auto-indexes session events file written by SessionStart hook
   - Dies when MCP server process exits

**Session restore flow** (compact/resume):
```
SessionStart hook → reads SessionDB → writes events as markdown file
                  → injects ~275 token directive (summary + search queries)
MCP server        → detects markdown file on next getStore() call
                  → auto-indexes into FTS5 → deletes file
LLM               → searches source:"session-events" for details on demand
```

Raw session events are **never injected into context**. Only a compact summary table + search queries are injected. The LLM searches for details via the existing `search()` MCP tool.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed
- Node.js 20+ or [Bun](https://bun.sh/) (recommended for speed)
- context-mode plugin installed via marketplace

## Local Development Setup

### 1. Clone and install

```bash
git clone https://github.com/mksglu/context-mode.git
cd context-mode
npm install
npm run build  # tsc compiles src/ → build/
```

### 2. Symlink the cache to your local clone

Claude Code's plugin system manages `~/.claude/plugins/installed_plugins.json` and **will revert manual edits on restart**. The reliable approach is to replace the cache directory with a symlink to your local clone.

First, find your cached version:

```bash
ls ~/.claude/plugins/cache/context-mode/context-mode/
# Example output: 0.9.23
```

Then replace it with a symlink:

```bash
# Back up the cache (use your actual version number)
mv ~/.claude/plugins/cache/context-mode/context-mode/0.9.23 \
   ~/.claude/plugins/cache/context-mode/context-mode/0.9.23.bak

# Symlink to your local clone
ln -s /path/to/your/clone/context-mode \
   ~/.claude/plugins/cache/context-mode/context-mode/0.9.23
```

Replace `/path/to/your/clone/context-mode` with your actual local path.

> **Why symlink?** The plugin system overwrites `installed_plugins.json` on every session start, reverting any manual path changes. A symlink lets the plugin system keep its managed path while the actual code resolves to your local clone.

> **Critical:** The symlink must point to the root of your clone (where `hooks/`, `build/`, and `src/` all live). Hooks registered in `hooks.json` use `${CLAUDE_PLUGIN_ROOT}` which resolves to this directory.

### 3. Update PreToolUse hook in settings

The symlink in step 2 ensures `hooks.json` (which registers PostToolUse, PreCompact, SessionStart, and UserPromptSubmit) resolves to your local clone via the plugin system. You only need to override PreToolUse in `~/.claude/settings.json` since its broader matcher is needed for dev mode:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Read|Grep|WebFetch|Agent|Task|mcp__plugin_context-mode_context-mode__ctx_execute|mcp__plugin_context-mode_context-mode__ctx_execute_file|mcp__plugin_context-mode_context-mode__ctx_batch_execute",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/your/clone/context-mode/hooks/pretooluse.mjs"
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/your/clone/context-mode` with your actual local path.

> **Important:** Do NOT add PostToolUse, PreCompact, SessionStart, or UserPromptSubmit to `settings.json` — they are already registered in `hooks.json` and the symlink makes them resolve to your local clone. Adding them to both causes double invocations, split session IDs, and SQLite locking errors.

### 4. Bump the version for verification

Change the version in your local clone to something recognizable:

```bash
# All 4 files must be updated:
# 1. package.json:              "version": "0.9.23-dev"
# 2. src/server.ts:             const VERSION = "0.9.23-dev";
# 3. .claude-plugin/plugin.json:     "version": "0.9.23-dev"
# 4. .claude-plugin/marketplace.json: "version": "0.9.23-dev"
```

Then rebuild:

```bash
npm run build
```

### 5. Kill cached MCP processes and restart

```bash
# Kill any running context-mode processes
pkill -f "context-mode.*start.mjs"

# Verify no processes remain
ps aux | grep context-mode | grep -v grep
# Should return nothing
```

Restart Claude Code (`/exit` then `claude`).

### 6. Verify local dev mode

Run `/context-mode:ctx-doctor` in Claude Code. You should see your dev version:

```
npm (MCP): WARN — local v0.9.23-dev, latest v0.9.23
```

The version warning is expected -- it confirms you're running from your local clone, not the cache.

### Restoring marketplace version

To switch back to the marketplace version:

```bash
# Remove symlink and restore backup
rm ~/.claude/plugins/cache/context-mode/context-mode/0.9.23
mv ~/.claude/plugins/cache/context-mode/context-mode/0.9.23.bak \
   ~/.claude/plugins/cache/context-mode/context-mode/0.9.23
```

Then revert hooks in `~/.claude/settings.json` and restart Claude Code.

## Development Workflow

### Build and test your changes

```bash
# TypeScript compilation
npm run build

# Run all tests (parallel via Vitest)
npm test

# Type checking only
npm run typecheck

# Watch mode
npm run test:watch
```

### What needs rebuild?

| Changed | Rebuild needed? | Why |
|---------|:-:|---|
| `hooks/*.mjs` | No | Plain JS, loaded fresh each invocation |
| `src/*.ts` | Yes | Compiles to `build/` (MCP server, executor, store) |
| `src/session/*.ts` | Yes | Compiles to `build/session/`, imported by hooks |
| `src/adapters/**/*.ts` | Yes | Compiles to `build/adapters/`, platform detection + hooks |
| `configs/*` | No | Static files, served directly |

After rebuilding, restart your Claude Code session. The MCP server reloads on session start.

> **Tip:** If you only changed hook files (`hooks/*.mjs`), just restart Claude Code — no rebuild needed. Hooks are plain JS loaded fresh on each invocation.

### Key files to know

| File | Purpose |
|---|---|
| `src/server.ts` | MCP server, tool handlers, auto-indexing of session events |
| `src/store.ts` | FTS5 content store (index, search, chunking) |
| `src/executor.ts` | Polyglot code executor (JS, Python, Shell, etc.) |
| `src/session/db.ts` | SessionDB — persistent session event storage |
| `src/session/extract.ts` | Event extractors for PostToolUse hook |
| `src/adapters/detect.ts` | Platform detection (Claude Code, Gemini CLI, etc.) |
| `src/adapters/types.ts` | HookAdapter interface, shared adapter types |
| `hooks/sessionstart.mjs` | Session lifecycle (startup/compact/resume/clear) |
| `hooks/posttooluse.mjs` | Real-time event capture from tool calls |
| `hooks/precompact.mjs` | Resume snapshot builder (fires before compact) |
| `hooks/pretooluse.mjs` | Tool routing + context window protection |
| `hooks/session-helpers.mjs` | Shared utilities (stdin reader, session ID, DB paths) |

## TDD Workflow

We follow test-driven development. Every PR must include tests.

**We strongly recommend installing the context-mode-ops skill** — it includes TDD enforcement, issue triage, PR review, and release automation with parallel subagent orchestration:

```bash
npx skills add mksglu/context-mode --skill context-mode-ops
```

### Red-Green-Refactor

1. **Red** -- Write a failing test for the behavior you want
2. **Green** -- Write the minimum code to make it pass
3. **Refactor** -- Clean up while keeping tests green

### Test file organization

**Do NOT create new test files.** Add your tests to the existing file that covers the same domain. We maintain a small number of well-organized test files — one per adapter, one per core module. Creating a new file per feature or per PR leads to fragmentation that makes the suite harder to navigate and maintain.

| Domain | Test File |
|---|---|
| Adapters | `tests/adapters/<platform>.test.ts` |
| Client detection | `tests/adapters/detect.test.ts`, `tests/adapters/client-map.test.ts` |
| Search & FTS5 | `tests/core/search.test.ts` |
| Server & tools | `tests/core/server.test.ts` |
| CLI & bundle | `tests/core/cli.test.ts` |
| Routing | `tests/core/routing.test.ts` |
| Hook routing | `tests/hooks/core-routing.test.ts` |
| Hook formatting | `tests/hooks/formatters.test.ts` |
| Hook integration | `tests/hooks/integration.test.ts` |
| Cursor hooks | `tests/hooks/cursor-hooks.test.ts` |
| Gemini hooks | `tests/hooks/gemini-hooks.test.ts` |
| VS Code hooks | `tests/hooks/vscode-hooks.test.ts` |
| Kiro hooks | `tests/hooks/kiro-hooks.test.ts` |
| Session DB | `tests/session/session-db.test.ts` |
| Session extract | `tests/session/session-extract.test.ts` |
| Session snapshot | `tests/session/session-snapshot.test.ts` |
| Session continuity | `tests/session/continuity.test.ts` |
| Session pipeline | `tests/session/session-pipeline.test.ts` |
| Executor | `tests/executor.test.ts` |
| Store/Search | `tests/store.test.ts` |
| Security | `tests/security.test.ts` |
| OpenClaw plugin | `tests/plugins/openclaw.test.ts` |

If your change doesn't fit any existing file, discuss with the maintainer before creating a new one.

### Output quality matters

When your change affects tool output (execute, search, fetch_and_index, etc.), always compare before and after:

1. Run the same prompt **before** your change (on `main`)
2. Run it **again** with your change
3. Include both outputs in your PR

## Testing the OpenClaw Adapter

The OpenClaw adapter has its own test suite and installation workflow.

### Running tests

```bash
npx vitest run tests/plugins/openclaw.test.ts tests/adapters/openclaw.test.ts
```

These tests run without a live OpenClaw instance — they mock the plugin API.

### Local OpenClaw testing

To test against a running OpenClaw gateway:

1. Install the plugin:
   ```bash
   npm run install:openclaw
   # Or with a custom state directory:
   npm run install:openclaw -- /path/to/openclaw-state
   ```
   The script picks up `$OPENCLAW_STATE_DIR` from your environment (default: `/openclaw`). It handles building, native dependency rebuild, extension registration, and gateway restart in one step.

2. Open a Pi Agent session and verify hooks fire by checking the debug log output.

See [`docs/adapters/openclaw.md`](docs/adapters/openclaw.md) for hook registration details and known upstream issues.

## Submitting a Bug Report

When filing a bug, **always include your prompt**. The exact message you sent to Claude Code is critical for reproduction. Without it, we can't debug the issue.

Required information:
- `/context-mode:doctor` output (must be latest version)
- The prompt that triggered the bug
- Debug logs from `Ctrl+O` (background tool calls and MCP communication)

## Submitting a Pull Request

1. Fork the repository
2. Create a feature branch from `main`
3. Follow the local development setup above
4. Write tests first (TDD)
5. Run `npm test` and `npm run typecheck`
6. Test in a live Claude Code session
7. Compare output quality before/after
8. Open a PR using the template

## Quick Reference

| Task | Command |
|---|---|
| Check version | `/context-mode:doctor` |
| Upgrade plugin | `/context-mode:upgrade` |
| View session stats | `/context-mode:stats` |
| See background steps | `Ctrl+O` |
| Kill cached server | `pkill -f "context-mode.*start.mjs"` |
| Rebuild after changes | `npm run build` |
| Run all tests | `npm test` |
| Watch mode | `npm run test:watch` |
