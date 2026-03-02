# Contributing to context-mode

This project is MIT-licensed and moves forward with your support. Every issue, every PR, every idea matters.

Don't overthink it. Don't ask yourself "is my PR good enough?" or "is this issue too small?" -- just send it. A rough draft beats a perfect plan that never ships. If you found a bug, report it. If you have an idea, open an issue. If you wrote a fix, submit the PR.

That said, I'm a solo maintainer with limited time. The best way to help me help you: follow the templates, include your `/context-mode:doctor` output, and write tests for your changes. The more context you give me, the faster I can review.

I genuinely love open source and I'm grateful to have you here. Don't hesitate to reach out -- whether it's a question, a suggestion, or just to say hi. Let's build this together.

---

This guide covers the local development workflow so you can test changes in a live Claude Code session before submitting a PR.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed
- Node.js 20+ or [Bun](https://bun.sh/) (recommended for speed)
- context-mode plugin installed via marketplace

## Local Development Setup

### 1. Clone and install

```bash
git clone https://github.com/mksglu/claude-context-mode.git
cd claude-context-mode/context-mode
npm install
npm run build
```

### 2. Point the plugin registry to your local clone

Open `~/.claude/plugins/installed_plugins.json` and find the `context-mode@claude-context-mode` entry. Change `installPath` to your local directory:

```json
"context-mode@claude-context-mode": [
  {
    "scope": "user",
    "installPath": "/path/to/your/clone/context-mode",
    "version": "0.9.17"
  }
]
```

### 3. Update the hook path in settings

Open `~/.claude/settings.json` and find the PreToolUse hook entry for context-mode. It will point to the cache directory -- change it to your local clone:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Read|Grep|Glob|WebFetch|WebSearch|Task",
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

Replace `/path/to/your/clone/context-mode` with your actual local path. Make sure there are no duplicate hook entries pointing to the old cache path.

### 4. Kill the cached MCP server

The marketplace version may already be running. You need to stop it so your local version takes over.

```bash
# Find running context-mode processes
ps aux | grep context-mode | grep -v grep

# Kill them
pkill -f "context-mode.*start.mjs"
```

Verify no cached processes remain:

```bash
ps aux | grep context-mode | grep -v grep
# Should return nothing
```

### 5. Make sure cache is not being used

Double-check that neither file references the cache:

```bash
# Plugin registry -- should show YOUR local path
grep installPath ~/.claude/plugins/installed_plugins.json | grep context-mode
# Expected: /path/to/your/clone/context-mode
# NOT: ~/.claude/plugins/cache/...

# Hook config -- should show YOUR local path
grep context-mode ~/.claude/settings.json
# Expected: /path/to/your/clone/context-mode/hooks/pretooluse.mjs
# NOT: ~/.claude/plugins/cache/...
```

### 6. Restart Claude Code

```bash
# Exit current session
# Ctrl+C or type /exit

# Relaunch Claude Code
claude
```

Claude Code will start a new MCP server from your local `installPath`.

### 7. Verify your local server is running

Run `/context-mode:doctor` in Claude Code. Confirm:
- All checks PASS
- The version matches your local `package.json`

**Tip:** Bump the version in your local `package.json` to something recognizable (e.g., `0.9.17-dev.1`). Then `/context-mode:doctor` will show that version, proving you're running from your local clone -- not the cache.

## Development Workflow

### Build and test your changes

```bash
# TypeScript compilation
npm run build

# Run all tests
npm run test:all

# Type checking only
npm run typecheck
```

### See changes in Claude Code

After modifying source code:

```bash
# Rebuild
npm run build
```

Then restart your Claude Code session. The MCP server reloads on session start.

### Available test suites

```bash
npm run test:all            # Run everything
npm run test:store          # FTS5 knowledge base tests
npm run test:fuzzy          # Fuzzy search tests
npm run test:hooks          # PreToolUse hook tests
npm run test:search-wiring  # Search pipeline tests
npm run test:search-fallback # Fallback integration tests
npm run test:stream-cap     # Stream capacity tests
npm run test:turndown       # HTML-to-markdown tests
npm run test:use-cases      # End-to-end use case tests
npm run test:compare        # Context savings comparison
npm run benchmark           # Performance benchmarks
```

## TDD Workflow

We follow test-driven development. Every PR must include tests.

**We strongly recommend installing the [TDD skill](https://github.com/anthropics/claude-code-skills) for Claude Code** -- it enforces the red-green-refactor loop automatically.

### Red-Green-Refactor

1. **Red** -- Write a failing test for the behavior you want
2. **Green** -- Write the minimum code to make it pass
3. **Refactor** -- Clean up while keeping tests green

### Output quality matters

When your change affects tool output (execute, search, fetch_and_index, etc.), always compare before and after:

1. Run the same prompt **before** your change (on `main`)
2. Run it **again** with your change
3. Include both outputs in your PR

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
5. Run `npm run test:all` and `npm run typecheck`
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
| Run all tests | `npm run test:all` |
