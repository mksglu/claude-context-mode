# Context Mode

**The other half of the context problem.**

[![users](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2Fmksglu%2Fcontext-mode%40main%2Fstats.json&query=%24.message&label=users&color=brightgreen)](https://www.npmjs.com/package/context-mode) [![npm](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2Fmksglu%2Fcontext-mode%40main%2Fstats.json&query=%24.npm&label=npm&color=blue)](https://www.npmjs.com/package/context-mode) [![marketplace](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2Fmksglu%2Fcontext-mode%40main%2Fstats.json&query=%24.marketplace&label=marketplace&color=blue)](https://github.com/mksglu/context-mode) [![GitHub stars](https://img.shields.io/github/stars/mksglu/context-mode?style=flat&color=yellow)](https://github.com/mksglu/context-mode/stargazers) [![GitHub forks](https://img.shields.io/github/forks/mksglu/context-mode?style=flat&color=blue)](https://github.com/mksglu/context-mode/network/members) [![Last commit](https://img.shields.io/github/last-commit/mksglu/context-mode?color=green)](https://github.com/mksglu/context-mode/commits) [![License: ELv2](https://img.shields.io/badge/License-ELv2-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/discord/1478479412700909750?label=Discord&logo=discord&color=5865f2)](https://discord.gg/DCN9jUgN5v)

## The Problem

Every MCP tool call dumps raw data into your context window. A Playwright snapshot costs 56 KB. Twenty GitHub issues cost 59 KB. One access log — 45 KB. After 30 minutes, 40% of your context is gone. And when the agent compacts the conversation to free space, it forgets which files it was editing, what tasks are in progress, and what you last asked for.

Context Mode is an MCP server that solves both halves of this problem:

1. **Context Saving** — Sandbox tools keep raw data out of the context window. 315 KB becomes 5.4 KB. 98% reduction.
2. **Session Continuity** — Every file edit, git operation, task, error, and user decision is tracked in SQLite. When the conversation compacts, context-mode doesn't dump this data back into context — it indexes events into FTS5 and retrieves only what's relevant via BM25 search. The model picks up exactly where you left off. If you don't `--continue`, previous session data is deleted immediately — a fresh session means a clean slate.

https://github.com/user-attachments/assets/07013dbf-07c0-4ef1-974a-33ea1207637b

## Install

<details open>
<summary><strong>Claude Code</strong></summary>

**Step 1 — Install the plugin:**

```bash
/plugin marketplace add mksglu/context-mode
/plugin install context-mode@context-mode
```

**Step 2 — Restart Claude Code.**

That's it. The plugin installs everything automatically:
- MCP server with 6 sandbox tools (`ctx_batch_execute`, `ctx_execute`, `ctx_execute_file`, `ctx_index`, `ctx_search`, `ctx_fetch_and_index`)
- PreToolUse hooks that intercept Bash, Read, WebFetch, Grep, and Task calls — nudging them toward sandbox execution
- PostToolUse, PreCompact, and SessionStart hooks for session tracking and context injection
- A `CLAUDE.md` routing instructions file auto-created in your project root
- Slash commands for diagnostics and upgrades (Claude Code only)

| Command | What it does |
|---|---|
| `/context-mode:ctx-stats` | Context savings — per-tool breakdown, tokens consumed, savings ratio. |
| `/context-mode:ctx-doctor` | Diagnostics — runtimes, hooks, FTS5, plugin registration, versions. |
| `/context-mode:ctx-upgrade` | Pull latest, rebuild, migrate cache, fix hooks. |

> **Note:** Slash commands are a Claude Code plugin feature. On other platforms, all three utility commands (`ctx stats`, `ctx doctor`, `ctx upgrade`) work as MCP tools — just type the command name and the model will invoke it. See [Utility Commands](#utility-commands).

**Alternative — MCP-only install** (no hooks or slash commands):

```bash
claude mcp add context-mode -- npx -y context-mode
```

This gives you the 6 sandbox tools but without automatic routing. The model can still use them — it just won't be nudged to prefer them over raw Bash/Read/WebFetch. Good for trying it out before committing to the full plugin.

</details>

<details>
<summary><strong>Gemini CLI</strong> <sup>(Beta)</sup></summary>

**Step 1 — Install globally:**

```bash
npm install -g context-mode
```

**Step 2 — Register the MCP server.** Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "context-mode": {
      "command": "context-mode"
    }
  }
}
```

**Step 3 — Add hooks.** Without hooks, the model can ignore routing instructions and dump raw output into your context window. Hooks intercept every tool call and enforce sandbox routing programmatically — blocking `curl`, `wget`, and other data-heavy commands before they execute. Add to the same `~/.gemini/settings.json`:

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "context-mode hook gemini-cli beforetool" }]
      }
    ],
    "AfterTool": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "context-mode hook gemini-cli aftertool" }]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "context-mode hook gemini-cli sessionstart" }]
      }
    ]
  }
}
```

**Step 4 — Restart Gemini CLI.** On first session start, the sessionstart hook automatically manages `GEMINI.md` routing instructions in your project root:

- **File does not exist** — the routing instructions file is written.
- **File exists without context-mode rules** — routing instructions are appended after your existing content.
- **File already contains context-mode rules** — skipped (idempotent, no duplicate content).

This works alongside hooks as a parallel enforcement layer — hooks block dangerous commands programmatically, while `GEMINI.md` teaches the model to prefer sandbox tools from the start.

> **Why hooks matter:** Without hooks, context-mode relies on `GEMINI.md` instructions alone (~60% compliance). The model sometimes follows them, but regularly runs raw `curl`, reads large files directly, or dumps unprocessed output into context — a single unrouted Playwright snapshot (56 KB) wipes out an entire session's savings. With hooks, every tool call is intercepted before execution — dangerous commands are blocked, and routing guidance is injected in real-time. This is the difference between ~60% and ~98% context savings.

Full hook config including PreCompress: [`configs/gemini-cli/settings.json`](configs/gemini-cli/settings.json)

</details>

<details>
<summary><strong>VS Code Copilot</strong> <sup>(Beta)</sup></summary>

**Step 1 — Install globally:**

```bash
npm install -g context-mode
```

**Step 2 — Register the MCP server.** Create `.vscode/mcp.json` in your project root:

```json
{
  "servers": {
    "context-mode": {
      "command": "context-mode"
    }
  }
}
```

**Step 3 — Add hooks.** Without hooks, the model can bypass routing and dump raw output into your context. Hooks intercept every tool call and enforce sandbox routing programmatically. Create `.github/hooks/context-mode.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "type": "command", "command": "context-mode hook vscode-copilot pretooluse" }
    ],
    "PostToolUse": [
      { "type": "command", "command": "context-mode hook vscode-copilot posttooluse" }
    ],
    "SessionStart": [
      { "type": "command", "command": "context-mode hook vscode-copilot sessionstart" }
    ]
  }
}
```

**Step 4 — Restart VS Code.** On first session start, the sessionstart hook automatically manages `.github/copilot-instructions.md` routing instructions in your project:

- **File does not exist** — `.github/` is created and the routing instructions file is written.
- **File exists without context-mode rules** — routing instructions are appended after your existing content, preserving project-level coding standards.
- **File already contains context-mode rules** — skipped (idempotent, no duplicate content).

This works alongside hooks as a parallel enforcement layer — hooks intercept tool calls programmatically, while `copilot-instructions.md` guides the model's tool selection from session start.

> **Why hooks matter:** Without hooks, `copilot-instructions.md` guides the model but can't block commands. A single unrouted Playwright snapshot (56 KB) or `gh issue list` (59 KB) wipes out minutes of context savings. With hooks, these calls are intercepted and redirected to the sandbox before they execute.

Full hook config including PreCompact: [`configs/vscode-copilot/hooks.json`](configs/vscode-copilot/hooks.json)

</details>

<details>
<summary><strong>Cursor</strong> <sup>(Beta)</sup></summary>

**Step 1 — Install globally:**

```bash
npm install -g context-mode
```

**Step 2 — Register the MCP server.** Create `.cursor/mcp.json` in your project root or `~/.cursor/mcp.json` for a global install:

```json
{
  "mcpServers": {
    "context-mode": {
      "command": "context-mode"
    }
  }
}
```

**Step 3 — Add native Cursor hooks.** Cursor v1 support uses native `.cursor/hooks.json` or `~/.cursor/hooks.json` only. Create either path with:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "command": "context-mode hook cursor pretooluse",
        "matcher": "Shell|Read|Grep|WebFetch|Task|MCP:ctx_execute|MCP:ctx_execute_file|MCP:ctx_batch_execute"
      }
    ],
    "postToolUse": [
      {
        "command": "context-mode hook cursor posttooluse"
      }
    ]
  }
}
```

Note: the `preToolUse` hook matcher is optional. If you don't provide it, the hook will fire on all tools.

**Step 4 — Restart Cursor or open a new agent session.** On first MCP server startup, routing instructions are auto-written to your project (same mechanism as Codex CLI).

> **Native Cursor scope:** `preToolUse` and `postToolUse` are supported. `sessionStart` is documented by Cursor but currently rejected by their validator ([forum report](https://forum.cursor.com/t/unknown-hook-type-sessionstart/149566)), so routing instructions are delivered via MCP server startup instead.
>
> **Config precedence:** project `.cursor/hooks.json` overrides `~/.cursor/hooks.json`.

Full native hook config: [`configs/cursor/hooks.json`](configs/cursor/hooks.json)  
Example MCP registration: [`configs/cursor/mcp.json`](configs/cursor/mcp.json)

</details>

<details>
<summary><strong>OpenCode</strong> <sup>(Beta)</sup></summary>

**Step 1 — Install globally:**

```bash
npm install -g context-mode
```

**Step 2 — Register the MCP server and plugin.** OpenCode uses a TypeScript plugin paradigm instead of JSON hooks. Add both the MCP server and the plugin to `opencode.json` in your project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "context-mode": {
      "type": "local",
      "command": ["context-mode"]
    }
  },
  "plugin": ["context-mode"]
}
```

The `mcp` entry gives you the 6 sandbox tools. The `plugin` entry enables hooks — OpenCode calls the plugin's TypeScript functions directly before and after each tool execution, blocking dangerous commands (like raw `curl`) and enforcing sandbox routing.

**Step 3 — Restart OpenCode.** On first plugin init, the plugin automatically manages `AGENTS.md` routing instructions in your project root:

- **File does not exist** — the routing instructions file is written.
- **File exists without context-mode rules** — routing instructions are appended after your existing content.
- **File already contains context-mode rules** — skipped (idempotent, no duplicate content).

This works alongside the plugin as a parallel enforcement layer — the plugin intercepts tool calls at runtime, while `AGENTS.md` guides the model's tool preferences from session start.

> **Why the plugin matters:** Without the `plugin` entry, context-mode has no way to intercept tool calls. The model can run raw `curl`, read large files directly, or dump unprocessed output into context — ignoring `AGENTS.md` instructions. With the plugin, `tool.execute.before` fires on every tool call and blocks or redirects data-heavy commands before they execute. The `experimental.session.compacting` hook builds and injects resume snapshots when the conversation compacts, preserving session state.
>
> Note: OpenCode's SessionStart hook is not yet available ([#14808](https://github.com/sst/opencode/issues/14808)), so startup/resume session restore is not supported — the `AGENTS.md` file is the primary way context-mode instructions reach the model at session start. Compaction recovery works fully via the plugin.

</details>

<details>
<summary><strong>Codex CLI</strong> <sup>(Beta)</sup></summary>

**Step 1 — Install globally:**

```bash
npm install -g context-mode
```

**Step 2 — Register the MCP server.** Add to `~/.codex/config.toml`:

```toml
[mcp_servers.context-mode]
command = "context-mode"
```

**Step 3 — Restart Codex CLI.** On first run, an `AGENTS.md` routing instructions file is auto-created in your project root. Codex CLI reads `AGENTS.md` automatically and learns to prefer context-mode sandbox tools.

**About hooks:** Codex CLI does not support hooks — PRs [#2904](https://github.com/openai/codex/pull/2904) and [#9796](https://github.com/openai/codex/pull/9796) were closed without merge. The `AGENTS.md` routing instructions file is the only enforcement method (~60% compliance). The model receives the instructions at session start and sometimes follows them, but there is no programmatic interception — it can run raw `curl`, read large files, or bypass sandbox tools at any time.

For stronger enforcement, you can also add the instructions globally:

```bash
cp ~/.codex/AGENTS.md  # auto-created, or copy from node_modules/context-mode/configs/codex/AGENTS.md
```

Global `~/.codex/AGENTS.md` applies to all projects. Project-level `./AGENTS.md` applies to the current project only. If both exist, Codex CLI merges them.

</details>

<details>
<summary><strong>Build Prerequisites</strong> <sup>(CentOS, RHEL, Alpine)</sup></summary>

Context Mode uses [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), which ships prebuilt native binaries for most platforms. On glibc >= 2.31 systems (Ubuntu 20.04+, Debian 11+, Fedora 34+, macOS, Windows), `npm install` works without any build tools.

On older glibc systems (CentOS 7/8, RHEL 8, Debian 10), prebuilt binaries don't load and better-sqlite3 **automatically falls back to compiling from source** via `prebuild-install || node-gyp rebuild --release`. This requires a C++20 compiler (GCC 10+), Make, and Python with setuptools.

**CentOS 8 / RHEL 8** (glibc 2.28):

```bash
dnf install -y gcc-toolset-10-gcc gcc-toolset-10-gcc-c++ make python3 python3-setuptools
scl enable gcc-toolset-10 'npm install -g context-mode'
```

**CentOS 7 / RHEL 7** (glibc 2.17):

```bash
yum install -y centos-release-scl
yum install -y devtoolset-10-gcc devtoolset-10-gcc-c++ make python3
pip3 install setuptools
scl enable devtoolset-10 'npm install -g context-mode'
```

**Alpine Linux:**

Alpine prebuilt binaries (musl) are available in better-sqlite3 v12.8.0+. With the `^12.6.2` dependency range, `npm install` resolves to the latest 12.x and works without build tools on Alpine. If you pin an older version:

```bash
apk add build-base python3 py3-setuptools
npm install -g context-mode
```

</details>

## Tools

| Tool | What it does | Context saved |
|---|---|---|
| `ctx_batch_execute` | Run multiple commands + search multiple queries in ONE call. | 986 KB → 62 KB |
| `ctx_execute` | Run code in 11 languages. Only stdout enters context. | 56 KB → 299 B |
| `ctx_execute_file` | Process files in sandbox. Raw content never leaves. | 45 KB → 155 B |
| `ctx_index` | Chunk markdown into FTS5 with BM25 ranking. | 60 KB → 40 B |
| `ctx_search` | Query indexed content with multiple queries in one call. | On-demand retrieval |
| `ctx_fetch_and_index` | Fetch URL, detect content type (HTML/JSON/text), chunk and index. | 60 KB → 40 B |
| `ctx_stats` | Show context savings, call counts, and session statistics. | — |
| `ctx_doctor` | Diagnose installation: runtimes, hooks, FTS5, versions. | — |
| `ctx_upgrade` | Upgrade to latest version from GitHub, rebuild, reconfigure hooks. | — |

## How the Sandbox Works

Each `ctx_execute` call spawns an isolated subprocess with its own process boundary. Scripts can't access each other's memory or state. The subprocess runs your code, captures stdout, and only that stdout enters the conversation context. The raw data — log files, API responses, snapshots — never leaves the sandbox.

Eleven language runtimes are available: JavaScript, TypeScript, Python, Shell, Ruby, Go, Rust, PHP, Perl, R, and Elixir. Bun is auto-detected for 3-5x faster JS/TS execution.

Authenticated CLIs work through credential passthrough — `gh`, `aws`, `gcloud`, `kubectl`, `docker` inherit environment variables and config paths without exposing them to the conversation.

When output exceeds 5 KB and an `intent` is provided, Context Mode switches to intent-driven filtering: it indexes the full output into the knowledge base, searches for sections matching your intent, and returns only the relevant matches with a vocabulary of searchable terms for follow-up queries.

## How the Knowledge Base Works

The `ctx_index` tool chunks markdown content by headings while keeping code blocks intact, then stores them in a **SQLite FTS5** (Full-Text Search 5) virtual table. Search uses **BM25 ranking** — a probabilistic relevance algorithm that scores documents based on term frequency, inverse document frequency, and document length normalization. **Porter stemming** is applied at index time so "running", "runs", and "ran" match the same stem.

When you call `ctx_search`, it returns relevant content snippets focused around matching query terms — not full documents, not approximations, the actual indexed content with smart extraction around what you're looking for. `ctx_fetch_and_index` extends this to URLs: fetch, convert HTML to markdown, chunk, index. The raw page never enters context.

### Fuzzy Search

Search uses a three-layer fallback to handle typos, partial terms, and substring matches:

- **Layer 1 — Porter stemming**: Standard FTS5 MATCH with porter tokenizer. "caching" matches "cached", "caches", "cach".
- **Layer 2 — Trigram substring**: FTS5 trigram tokenizer matches partial strings. "useEff" finds "useEffect", "authenticat" finds "authentication".
- **Layer 3 — Fuzzy correction**: Levenshtein distance corrects typos before re-searching. "kuberntes" → "kubernetes", "autentication" → "authentication".

### Smart Snippets

Search results use intelligent extraction instead of truncation. Instead of returning the first N characters (which might miss the important part), Context Mode finds where your query terms appear in the content and returns windows around those matches.

### Progressive Throttling

- **Calls 1-3:** Normal results (2 per query)
- **Calls 4-8:** Reduced results (1 per query) + warning
- **Calls 9+:** Blocked — redirects to `ctx_batch_execute`

## Session Continuity

When the context window fills up, the agent compacts the conversation — dropping older messages to make room. Without session tracking, the model forgets which files it was editing, what tasks are in progress, what errors were resolved, and what you last asked for.

Context Mode captures every meaningful event during your session and persists them in a per-project SQLite database. When the conversation compacts (or you resume with `--continue`), your working state is rebuilt automatically — the model continues from your last prompt without asking you to repeat anything.

Session continuity requires 4 hooks working together:

| Hook | Role | Claude Code | Gemini CLI | VS Code Copilot | Cursor | OpenCode | Codex CLI |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **PostToolUse** | Captures events after each tool call | Yes | Yes | Yes | Yes | Plugin | -- |
| **UserPromptSubmit** | Captures user decisions and corrections | Yes | -- | -- | -- | -- | -- |
| **PreCompact** | Builds snapshot before compaction | Yes | Yes | Yes | -- | Plugin | -- |
| **SessionStart** | Restores state after compaction or resume | Yes | Yes | Yes | -- | -- | -- |
| | **Session completeness** | **Full** | **High** | **High** | **Partial** | **High** | **--** |

> **Note:** Full session continuity (capture + snapshot + restore) works on **Claude Code**, **Gemini CLI**, **VS Code Copilot**, and **OpenCode**. **Cursor** captures tool events via `preToolUse`/`postToolUse`, but `sessionStart` is currently rejected by Cursor's validator ([forum report](https://forum.cursor.com/t/unknown-hook-type-sessionstart/149566)), so session restore after compaction is not available yet. **OpenCode** uses the `experimental.session.compacting` plugin hook for compaction recovery, but SessionStart is not yet available ([#14808](https://github.com/sst/opencode/issues/14808)), so startup/resume is not supported. Codex CLI has no hook support, so session tracking is not available.

<details>
<summary><strong>What gets captured</strong></summary>

Every tool call passes through hooks that extract structured events:

| Category | Events | Priority | Captured By |
|---|---|---|---|
| **Files** | read, edit, write, glob, grep | Critical (P1) | PostToolUse |
| **Tasks** | create, update, complete | Critical (P1) | PostToolUse |
| **Rules** | CLAUDE.md / GEMINI.md / AGENTS.md paths + content | Critical (P1) | SessionStart |
| **Decisions** | User corrections, preferences ("use X instead", "don't do Y") | High (P2) | UserPromptSubmit |
| **Git** | checkout, commit, merge, rebase, stash, push, pull, diff, status | High (P2) | PostToolUse |
| **Errors** | Tool failures, non-zero exit codes | High (P2) | PostToolUse |
| **Environment** | cwd changes, venv, nvm, conda, package installs | High (P2) | PostToolUse |
| **MCP Tools** | All `mcp__*` tool calls with usage counts | Normal (P3) | PostToolUse |
| **Subagents** | Agent tool invocations | Normal (P3) | PostToolUse |
| **Skills** | Slash command invocations | Normal (P3) | PostToolUse |
| **Role** | Persona / behavioral directives ("act as senior engineer") | Normal (P3) | UserPromptSubmit |
| **Intent** | Session mode classification (investigate, implement, debug) | Low (P4) | UserPromptSubmit |
| **Data** | Large user-pasted data references (>1 KB) | Low (P4) | UserPromptSubmit |
| **User Prompts** | Every user message (for last-prompt restore) | Critical (P1) | UserPromptSubmit |

</details>

<details>
<summary><strong>How sessions survive compaction</strong></summary>

```
PreCompact fires
  → Read all session events from SQLite
  → Build priority-tiered XML snapshot (≤2 KB)
  → Store snapshot in session_resume table

SessionStart fires (source: "compact")
  → Retrieve stored snapshot
  → Write structured events file → auto-indexed into FTS5
  → Build Session Guide with 15 categories
  → Inject <session_knowledge> directive into context
  → Model continues from last user prompt with full working state
```

The snapshot is built in priority tiers — if the 2 KB budget is tight, lower-priority events (intent, MCP tool counts) are dropped first while critical state (active files, tasks, rules, decisions) is always preserved.

After compaction, the model receives a **Session Guide** — a structured narrative with actionable sections:

- **Last Request** — user's last prompt, so the model continues without asking "what were we doing?"
- **Tasks** — checkbox format with completion status (`[x]` completed, `[ ]` pending)
- **Key Decisions** — user corrections and preferences ("use X instead", "don't do Y")
- **Files Modified** — all files touched during the session
- **Unresolved Errors** — errors that haven't been fixed
- **Git** — operations performed (checkout, commit, push, status)
- **Project Rules** — CLAUDE.md / GEMINI.md / AGENTS.md paths
- **MCP Tools Used** — tool names with call counts
- **Subagent Tasks** — delegated work summaries
- **Skills Used** — slash commands invoked
- **Environment** — working directory, env variables
- **Data References** — large data pasted during the session
- **Session Intent** — mode classification (implement, investigate, review, discuss)
- **User Role** — behavioral directives set during the session

Detailed event data is also indexed into FTS5 for on-demand retrieval via `search()`.

</details>

<details>
<summary><strong>Per-platform details</strong></summary>

**Claude Code** — Full session support. All 5 hook types fire, capturing tool events, user decisions, building compaction snapshots, and restoring state after compaction or `--continue`.

**Gemini CLI** — High coverage. PostToolUse (AfterTool), PreCompact (PreCompress), and SessionStart all fire. Missing UserPromptSubmit, so user decisions and corrections aren't captured — but file edits, git ops, errors, and tasks are fully tracked.

**VS Code Copilot** — High coverage. Same as Gemini CLI — PostToolUse, PreCompact, and SessionStart all fire. User decisions aren't captured but all tool-level events are.

**Cursor** — Partial coverage. Native `preToolUse` and `postToolUse` hooks capture tool events. `sessionStart` is documented by Cursor but currently rejected by their validator, so session restore is not available. Routing instructions are delivered via MCP server startup instead.

**OpenCode** — Partial. The TypeScript plugin captures PostToolUse events via `tool.execute.after`, but SessionStart is not yet available ([#14808](https://github.com/sst/opencode/issues/14808)). Events are stored but not automatically restored after compaction. The `AGENTS.md` routing instructions file compensates by re-teaching tool preferences at each session start.

**Codex CLI** — No session support. No hooks means no event capture. Each compaction or new session starts fresh. The `AGENTS.md` routing instructions file is the only continuity mechanism.

</details>

## Platform Compatibility

| Feature | Claude Code | Gemini CLI <sup>(Beta)</sup> | VS Code Copilot <sup>(Beta)</sup> | Cursor <sup>(Beta)</sup> | OpenCode <sup>(Beta)</sup> | Codex CLI <sup>(Beta)</sup> |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| MCP Server | Yes | Yes | Yes | Yes | Yes | Yes |
| PreToolUse Hook | Yes | Yes | Yes | Yes | Plugin | -- |
| PostToolUse Hook | Yes | Yes | Yes | Yes | Plugin | -- |
| SessionStart Hook | Yes | Yes | Yes | -- | -- | -- |
| PreCompact Hook | Yes | Yes | Yes | -- | Plugin | -- |
| Can Modify Args | Yes | Yes | Yes | Yes | Plugin | -- |
| Can Block Tools | Yes | Yes | Yes | Yes | Plugin | -- |
| Utility Commands (ctx) | Yes | Yes | Yes | Yes | Yes | Yes |
| Slash Commands | Yes | -- | -- | -- | -- | -- |
| Plugin Marketplace | Yes | -- | -- | -- | -- | -- |

> **OpenCode** uses a TypeScript plugin paradigm — hooks run as in-process functions via `tool.execute.before`, `tool.execute.after`, and `experimental.session.compacting`, providing the same routing enforcement and session continuity as shell-based hooks. SessionStart is not yet available ([#14808](https://github.com/sst/opencode/issues/14808)), but compaction recovery works via the plugin's compacting hook.
>
> **Codex CLI** does not support hooks. It relies solely on routing instruction files (`AGENTS.md`) for enforcement (~60% compliance).

### Routing Enforcement

Hooks intercept tool calls programmatically — they can block dangerous commands and redirect them to the sandbox before execution. Instruction files guide the model via prompt instructions but cannot block anything. **Always enable hooks where supported.**

| Platform | Hooks | Instruction File | With Hooks | Without Hooks |
|---|:---:|---|:---:|:---:|
| Claude Code | Yes (auto) | [`CLAUDE.md`](configs/claude-code/CLAUDE.md) | **~98% saved** | ~60% saved |
| Gemini CLI | Yes | [`GEMINI.md`](configs/gemini-cli/GEMINI.md) | **~98% saved** | ~60% saved |
| VS Code Copilot | Yes | [`copilot-instructions.md`](configs/vscode-copilot/copilot-instructions.md) | **~98% saved** | ~60% saved |
| Cursor | Yes | -- | **~98% saved** | Manual tool choice |
| OpenCode | Plugin | [`AGENTS.md`](configs/opencode/AGENTS.md) | **~98% saved** | ~60% saved |
| Codex CLI | -- | [`AGENTS.md`](configs/codex/AGENTS.md) | -- | ~60% saved |

Without hooks, one unrouted `curl` or Playwright snapshot can dump 56 KB into context — wiping out an entire session's worth of savings.

See [`docs/platform-support.md`](docs/platform-support.md) for the full capability comparison.

## Utility Commands

**Inside any AI session** — just type the command. The LLM calls the MCP tool automatically:

```
ctx stats       → context savings, call counts, session report
ctx doctor      → diagnose runtimes, hooks, FTS5, versions
ctx upgrade     → update from GitHub, rebuild, reconfigure hooks
```

**From your terminal** — run directly without an AI session:

```bash
context-mode doctor
context-mode upgrade
```

Works on **all platforms**. On Claude Code, slash commands (`/ctx-stats`, `/ctx-doctor`, `/ctx-upgrade`) are also available.

## Benchmarks

| Scenario | Raw | Context | Saved |
|---|---|---|---|
| Playwright snapshot | 56.2 KB | 299 B | 99% |
| GitHub Issues (20) | 58.9 KB | 1.1 KB | 98% |
| Access log (500 requests) | 45.1 KB | 155 B | 100% |
| Context7 React docs | 5.9 KB | 261 B | 96% |
| Analytics CSV (500 rows) | 85.5 KB | 222 B | 100% |
| Git log (153 commits) | 11.6 KB | 107 B | 99% |
| Test output (30 suites) | 6.0 KB | 337 B | 95% |
| Repo research (subagent) | 986 KB | 62 KB | 94% |

Over a full session: 315 KB of raw output becomes 5.4 KB. Session time extends from ~30 minutes to ~3 hours.

[Full benchmark data with 21 scenarios →](BENCHMARK.md)

## Try It

These prompts work out of the box. Run `/context-mode:ctx-stats` after each to see the savings.

**Deep repo research** — 5 calls, 62 KB context (raw: 986 KB, 94% saved)
```
Research https://github.com/modelcontextprotocol/servers — architecture, tech stack,
top contributors, open issues, and recent activity. Then run /context-mode:ctx-stats.
```

**Git history analysis** — 1 call, 5.6 KB context
```
Clone https://github.com/facebook/react and analyze the last 500 commits:
top contributors, commit frequency by month, and most changed files.
Then run /context-mode:ctx-stats.
```

**Web scraping** — 1 call, 3.2 KB context
```
Fetch the Hacker News front page, extract all posts with titles, scores,
and domains. Group by domain. Then run /context-mode:ctx-stats.
```

**Large JSON API** — 7.5 MB raw → 0.9 KB context (99% saved)
```
Create a local server that returns a 7.5 MB JSON with 20,000 records and a secret
hidden at index 13000. Fetch the endpoint, find the hidden record, and show me
exactly what's in it. Then run /context-mode:ctx-stats.
```

**Documentation search** — 2 calls, 1.8 KB context
```
Fetch the React useEffect docs, index them, and find the cleanup pattern
with code examples. Then run /context-mode:ctx-stats.
```

**Session continuity** — compaction recovery with full state
```
Start a multi-step task: "Create a REST API with Express — add routes, tests,
and error handling." After 20+ tool calls, type: ctx stats to see the session
event count. When context compacts, the model continues from your last prompt
with tasks, files, and decisions intact — no re-prompting needed.
```

## Security

Context Mode enforces the same permission rules you already use — but extends them to the MCP sandbox. If you block `sudo`, it's also blocked inside `ctx_execute`, `ctx_execute_file`, and `ctx_batch_execute`.

**Zero setup required.** If you haven't configured any permissions, nothing changes. This only activates when you add rules.

```json
{
  "permissions": {
    "deny": [
      "Bash(sudo *)",
      "Bash(rm -rf /*)",
      "Read(.env)",
      "Read(**/.env*)"
    ],
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)"
    ]
  }
}
```

Add this to your project's `.claude/settings.json` (or `~/.claude/settings.json` for global rules). All platforms read security policies from Claude Code's settings format — even on Gemini CLI, VS Code Copilot, and OpenCode. Codex CLI has no hook support, so security enforcement is not available.

The pattern is `Tool(what to match)` where `*` means "anything".

Commands chained with `&&`, `;`, or `|` are split — each part is checked separately. `echo hello && sudo rm -rf /tmp` is blocked because the `sudo` part matches the deny rule.

**deny** always wins over **allow**. More specific (project-level) rules override global ones.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and TDD guidelines.

```bash
git clone https://github.com/mksglu/context-mode.git
cd context-mode && npm install && npm test
```

## License

[Elastic License 2.0 (ELv2)](LICENSE) — free to use, modify, and share. You may not rebrand and redistribute this software as a competing plugin, product, or managed service.
