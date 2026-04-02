# PRD: context-mode-ops Skill

## Overview

A single Claude Code skill with 3 workflows that automates GitHub issue triage, PR review, and releases for the context-mode project using parallel subagent armies.

## Problem

Every incoming issue and PR requires:
- Manual analysis of affected adapters (12), OS compatibility (3), core modules
- Manual validation of claims (fake ENVs, hallucinated hooks, non-existent features)
- Manual testing across adapters and platforms
- Manual communication with contributors
- Manual release orchestration (version bump, tag, publish, branch sync)

This is repetitive, error-prone, and doesn't scale.

## Solution

One skill, three workflows, dynamic agent teams:

### Workflow 1: Triage Issue (`triage #N`)

1. Read issue body + comments via `gh`
2. Classify affected domains (adapters, OS, core modules)
3. Spawn dynamic agent team based on classification
4. Agents investigate, fix, test in parallel (ping-pong with architects)
5. Open PR to `next` branch
6. Comment on issue: technical explanation + "will ship in next release, please test"

### Workflow 2: Review PR (`review #N`)

1. Read PR diff + comments via `gh`
2. Classify affected domains
3. Spawn agent team to validate:
   - Code quality (architects)
   - Claims validation via websearch + context7 (e.g., fake ENV vars, non-existent hooks)
   - Test all affected adapters + OS
4. Strategy: **merge first, fix on top** (don't request changes — contributors ghost)
5. Comment: polite, technical, responsibility on contributor to test

### Workflow 3: Release (`release`)

1. `npm version patch` (triggers version-sync to all manifests)
2. `npm run build` + `npm run typecheck` + `npm test`
3. `git tag` + `gh release create`
4. `npm publish` (local)
5. Sync `next` ← `main` (or vice versa)
6. Clean remote branches (with user approval for each)

## Architecture

### Agent Organization

```
Engineering Manager (main conversation)
├── Core Agents (always spawned)
│   ├── Context Mode Architect — reviews all changes
│   ├── QA Engineer — runs tests, validates across adapters/OS
│   └── Security Engineer — if security-related
│
├── Platform Agents (spawned by detection)
│   ├── {Platform} Architect — reviews platform-specific changes
│   └── {Platform} Staff Engineer — implements fixes
│   (12 platforms: claude-code, gemini-cli, opencode, openclaw,
│    kilo, codex, vscode-copilot, cursor, antigravity, kiro, pi, zed)
│
└── Domain Agents (spawned by content)
    ├── Database Architect — FTS5, SQLite, better-sqlite3
    ├── OS Compatibility Architect — Windows/macOS/Linux
    ├── Hooks Architect — PreToolUse, PostToolUse, SessionStart
    ├── Session Architect — continuity, compaction, snapshots
    ├── Executor Architect — sandbox, polyglot runtime
    └── Web/Fetch Architect — fetch_and_index, turndown
```

### Ping-Pong Protocol

```
Staff Engineer writes code → Architect reviews → approve/reject
    ↓ (if rejected)
Staff Engineer fixes → Architect re-reviews → approve
    ↓ (if approved)
EM validates all architects agree → Ship
```

### Parallelism Rules

- ALL agents spawn in ONE message (multiple Agent tool calls)
- Each agent gets `isolation: "worktree"` for code changes
- Minimum 5, maximum 20 agents per task
- Architects and Staff Engineers work in pairs, ping-ponging within worktrees
- EM monitors all agents, resolves conflicts

## Adapters (12)

| Platform | Adapter Path | Test File | ENV Vars |
|----------|-------------|-----------|----------|
| Claude Code | `src/adapters/claude-code/` | `tests/adapters/claude-code.test.ts` | `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID` |
| Gemini CLI | `src/adapters/gemini-cli/` | `tests/adapters/gemini-cli.test.ts` | `GEMINI_PROJECT_DIR`, `GEMINI_CLI` |
| OpenCode | `src/adapters/opencode/` | `tests/adapters/opencode.test.ts` | `OPENCODE`, `OPENCODE_PID` |
| OpenClaw | `src/adapters/openclaw/` | `tests/adapters/openclaw.test.ts` | `OPENCLAW_HOME`, `OPENCLAW_CLI` |
| Kilo | `src/adapters/kilo/` | `tests/adapters/kilo.test.ts` | `KILO`, `KILO_PID` |
| Codex | `src/adapters/codex/` | `tests/adapters/codex.test.ts` | `CODEX_CI`, `CODEX_THREAD_ID` |
| VS Code Copilot | `src/adapters/vscode-copilot/` | `tests/adapters/vscode-copilot.test.ts` | `VSCODE_PID`, `VSCODE_CWD` |
| Cursor | `src/adapters/cursor/` | `tests/adapters/cursor.test.ts` | `CURSOR_TRACE_ID`, `CURSOR_CLI` |
| Antigravity | `src/adapters/antigravity/` | `tests/adapters/antigravity.test.ts` | — |
| Kiro | `src/adapters/kiro/` | `tests/adapters/kiro.test.ts` | — |
| Pi | `src/adapters/pi/` | `tests/adapters/pi.test.ts` | — |
| Zed | `src/adapters/zed/` | `tests/adapters/zed.test.ts` | — |

## OS Compatibility (3)

| OS | Key Concerns |
|----|-------------|
| macOS | Default dev platform, homebrew paths, `.dylib` bindings |
| Linux | CI/CD, snap/PATH limitations, `.so` bindings |
| Windows | Path separators, `\` vs `/`, Git Bash vs WSL, `.node` bindings |

## Core Modules

| Module | Path | Concerns |
|--------|------|----------|
| MCP Server | `src/server.ts` | Tool handlers, auto-indexing |
| FTS5 Store | `src/store.ts` | Content indexing, BM25 search |
| Executor | `src/executor.ts` | Polyglot sandbox, smart truncation |
| Session DB | `src/session/db.ts` | Event persistence |
| Session Extract | `src/session/extract.ts` | PostToolUse event capture |
| Adapter Detect | `src/adapters/detect.ts` | Platform detection logic |
| Adapter Types | `src/adapters/types.ts` | HookAdapter interface |
| CLI | `src/cli.ts` | Setup, doctor, upgrade commands |

## Validation Strategy

### ENV Variable Verification
- Every ENV var claimed in an issue/PR must be verified via:
  1. `Grep` in context-mode source code
  2. WebSearch for official platform docs
  3. Context7 for library-specific validation
- Flag any ENV that only exists in LLM training data but not in actual platform source

### Adapter Compatibility
- Run `npx vitest run tests/adapters/` for ALL adapter tests
- Run `npm run typecheck` for type safety
- Check `src/adapters/detect.ts` for detection logic consistency

### Cross-OS Validation
- Check `process.platform` usage
- Validate path separators (`path.join` vs string concat)
- Check `child_process` spawn options
- Validate `better-sqlite3` native binding paths

## Communication Policy

### On Issues (after fix)
- Explain technically what was fixed and why
- Reference the branch/PR where fix lands
- Say "this will ship in the next release — please test when it's out"
- Be warm, professional, grateful for the report

### On PRs (during review)
- Prefer merging over requesting changes (contributors ghost on change requests)
- If merging: fix issues on top in a follow-up commit
- Always ask contributor to test after merge
- Frame responsibility on them: "you know this area best — please verify"
- Never leave PRs hanging — decide quickly

## Release Checklist

1. [ ] All tests pass: `npm test`
2. [ ] Type check passes: `npm run typecheck`
3. [ ] Version bump: `npm version patch`
4. [ ] Build: `npm run build`
5. [ ] Git tag created
6. [ ] GitHub release created with changelog
7. [ ] npm published: `npm publish`
8. [ ] `next` branch synced with `main`
9. [ ] Stale remote branches cleaned (with user approval)

## File Structure

```
skills/context-mode-ops/
├── SKILL.md              # Main entry (<100 lines)
├── agents.md             # Dynamic agent organization & ping-pong
├── triage-issue.md       # Issue triage workflow
├── review-pr.md          # PR review workflow
├── release.md            # Release workflow
├── validation.md         # Cross-cutting validation patterns
└── communication.md      # Issue/PR comment templates
```
