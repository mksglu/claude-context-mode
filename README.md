# Context Mode

**Stop losing context to large outputs.**

[![npm](https://img.shields.io/npm/v/context-mode)](https://www.npmjs.com/package/context-mode) [![marketplace](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmksglu%2Fclaude-context-mode%2Fmain%2F.claude-plugin%2Fmarketplace.json&query=%24.plugins%5B0%5D.version&label=marketplace&color=brightgreen)](https://github.com/mksglu/claude-context-mode) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Run tests without burning 5K tokens. Query docs without loading raw HTML. Debug logs without reading 45KB of noise. Only summaries reach Claude — everything else stays in the sandbox.

```
Without Context Mode                          With Context Mode
─────────────────────                         ────────────────────
Playwright snapshot → 56 KB into context      → 299 B summary
GitHub issues (20)  → 59 KB into context      → 1.1 KB summary
Access log (500)    → 45 KB into context      → 155 B summary
Context7 docs       →  6 KB into context      → 261 B summary

Total: 166 KB = 42K tokens gone               Total: 1.8 KB = ~450 tokens
```

## Install

```bash
claude mcp add context-mode -- npx -y context-mode
```

Restart Claude Code. Done. You now have 5 tools that intercept large outputs and return only what matters.

<details>
<summary><strong>Plugin install</strong> (includes auto-routing skill)</summary>

```bash
/plugin marketplace add mksglu/claude-context-mode
/plugin install context-mode@claude-context-mode
```

Installs the MCP server + a skill that automatically guides Claude to route large outputs through Context Mode. No prompting needed.

</details>

<details>
<summary><strong>Local development</strong></summary>

```bash
claude --plugin-dir ./path/to/context-mode
```

</details>

## What It Does

Every MCP tool call dumps raw data into your 200K context window. With [81+ tools active, 143K tokens (72%) get consumed before your first message](https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code). Context Mode intercepts these operations, processes data in isolated subprocesses, and returns only what you need.

**Result:** 315 KB raw data becomes 5.4 KB of context across 14 real scenarios — **98% savings**.

| Metric | Without | With |
|---|---|---|
| Context consumed per session | 315 KB | 5.4 KB |
| Time before slowdown | ~30 min | ~3 hours |
| Context remaining after 45 min | 60% | 99% |

## Tools

### `execute` — Run code in sandbox

Execute code in 10 languages (JS, TS, Python, Shell, Ruby, Go, Rust, PHP, Perl, R). Only stdout enters context.

```
execute({ language: "shell", code: "gh pr list --json title,state | jq length" })
→ "3"                                           ← 2 bytes instead of 8KB
```

Add `intent` for large outputs — Context Mode filters to relevant sections automatically:

```
execute({ language: "shell", code: "cat app.log", intent: "database connection error" })
→ matching sections + searchable terms           ← 500B instead of 100KB
```

Authenticated CLIs work out of the box — `gh`, `aws`, `gcloud`, `kubectl`, `docker` credentials pass through. Bun auto-detected for 3-5x faster JS/TS.

### `execute_file` — Process files without loading

File contents stay in the sandbox as `FILE_CONTENT`. Your code summarizes. Only the summary enters context.

```
execute_file({ path: "access.log", language: "python", code: "..." })
→ "200: 312 | 404: 89 | 500: 14"                ← 30 bytes instead of 45KB
```

### `index` + `search` — Searchable knowledge base

Index documentation into FTS5 with BM25 ranking. Search returns exact code blocks — not summaries.

```
index({ content: <60KB React docs>, source: "React useEffect" })
→ "Indexed 33 sections (15 with code)"           ← 40 bytes

search({ query: "useEffect cleanup function" })
→ exact code example with heading context        ← 500 bytes instead of 60KB
```

### `fetch_and_index` — Fetch URLs into knowledge base

Fetches, converts HTML to markdown, indexes. Raw content never enters context. Use instead of WebFetch or Context7 when you need to reference docs multiple times.

```
fetch_and_index({ url: "https://react.dev/reference/react/useEffect" })
→ "Indexed 33 sections (15 with code)"           ← 40 bytes instead of 60KB
```

## Example Prompts

Just ask naturally — Claude routes through Context Mode automatically when it saves tokens.

```
"Analyze the last 50 commits and find the most frequently changed files"
"Read the access log and break down requests by HTTP status code"
"Run the test suite and give me a pass/fail summary"
"Fetch the React useEffect docs and find the cleanup pattern"
"List all Docker containers with their memory usage"
"Find all TODO comments across the codebase"
"Analyze package-lock.json and find the 10 largest dependencies"
"Show running Kubernetes pods and their restart counts"
```

## Real-World Benchmarks

| Operation | Raw | Context | Savings |
|---|---|---|---|
| Playwright `browser_snapshot` | 56.2 KB | 299 B | **99%** |
| GitHub Issues (20) | 58.9 KB | 1.1 KB | **98%** |
| Access log (500 requests) | 45.1 KB | 155 B | **100%** |
| Context7 React docs | 5.9 KB | 261 B | **96%** |
| Analytics CSV (500 rows) | 85.5 KB | 222 B | **100%** |
| Git log (153 commits) | 11.6 KB | 107 B | **99%** |
| Test output (30 suites) | 6.0 KB | 337 B | **95%** |

[Full benchmark data with 21 scenarios →](BENCHMARK.md)

## How It Works

```
┌─────────────┐    stdio / JSON-RPC     ┌─────────────────────────────────┐
│ Claude Code │ ◄─────────────────────► │  Context Mode MCP Server        │
│             │    tool calls/results    │                                 │
└─────────────┘                          │  Sandboxed subprocesses         │
                                         │  • 10 language runtimes         │
                                         │  • Auth passthrough (gh, aws…)  │
                                         │  • Intent-driven search         │
                                         │                                 │
                                         │  SQLite FTS5 knowledge base     │
                                         │  • BM25 ranking                 │
                                         │  • Porter stemming              │
                                         │  • Heading-aware chunking       │
                                         └─────────────────────────────────┘
```

Each `execute` call spawns an isolated subprocess — scripts can't access each other, but authenticated CLIs (`gh`, `aws`, `gcloud`) find their configs through secure credential passthrough.

## Requirements

- **Node.js 18+**
- **Claude Code** with MCP support
- Optional: Bun (auto-detected, 3-5x faster JS/TS)

## Development

```bash
git clone https://github.com/mksglu/claude-context-mode.git
cd claude-context-mode && npm install
npm test              # 100+ tests across 4 suites
npm run test:all      # full suite
```

## License

MIT
