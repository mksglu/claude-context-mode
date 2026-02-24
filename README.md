# Context Mode

**The other half of the context problem.**

[![npm](https://img.shields.io/npm/v/context-mode)](https://www.npmjs.com/package/context-mode) [![marketplace](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmksglu%2Fclaude-context-mode%2Fmain%2F.claude-plugin%2Fmarketplace.json&query=%24.plugins%5B0%5D.version&label=marketplace&color=brightgreen)](https://github.com/mksglu/claude-context-mode) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Inspired by Cloudflare's [Code Mode](https://blog.cloudflare.com/code-mode-mcp/) — which compresses tool definitions from millions of tokens into ~1,000 — we asked: what about the other direction? Every tool call that returns data dumps raw output into the context window. 56 KB from a browser snapshot. 59 KB from twenty GitHub issues. 45 KB from an access log.

Context Mode intercepts these outputs, processes them in isolated sandboxes, and returns only what matters. The raw data never enters context.

```
Without Context Mode                          With Context Mode
─────────────────────                         ────────────────────
Playwright snapshot → 56 KB into context      → 299 B summary
GitHub issues (20)  → 59 KB into context      → 1.1 KB summary
Access log (500)    → 45 KB into context      → 155 B summary
Context7 docs       →  6 KB into context      → 261 B summary

Total: 166 KB = 42K tokens gone               Total: 1.8 KB = ~450 tokens
```

**315 KB of raw output becomes 5.4 KB across 14 real scenarios. 98% reduction.**

## Install

```bash
claude mcp add context-mode -- npx -y context-mode
```

Restart Claude Code. Done.

<details>
<summary><strong>Plugin install</strong> (includes auto-routing skill)</summary>

```bash
/plugin marketplace add mksglu/claude-context-mode
/plugin install context-mode@claude-context-mode
```

Installs the MCP server + a skill that automatically routes large outputs through Context Mode. No prompting needed.

</details>

<details>
<summary><strong>Local development</strong></summary>

```bash
claude --plugin-dir ./path/to/context-mode
```

</details>

## The Problem

MCP has become the standard way for AI agents to use external tools. But there is a tension at its core: every tool interaction fills the context window from both sides — definitions on the way in, raw output on the way out.

With [81+ tools active, 143K tokens (72%) get consumed before your first message](https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code). And then the tools start returning data. A single Playwright snapshot burns 56 KB. A `gh issue list` dumps 59 KB. Run a test suite, read a log file, fetch documentation — each response eats into what remains.

Code Mode showed that tool definitions can be compressed by 99.9%. Context Mode applies the same principle to tool outputs — processing them in sandboxes so only summaries reach the model.

## How It Works

Context Mode is an MCP server. It exposes five tools that process data in isolated subprocesses and return only summaries to the context window.

```
┌─────────────┐    stdio / JSON-RPC     ┌──────────────────────────────────┐
│ Claude Code │ ◄─────────────────────► │  Context Mode MCP Server         │
│             │    tool calls/results    │                                  │
└─────────────┘                          │  Sandboxed subprocesses          │
                                         │  • 10 language runtimes          │
                                         │  • Credential passthrough        │
                                         │  • Intent-driven filtering       │
                                         │                                  │
                                         │  FTS5 knowledge base             │
                                         │  • BM25 ranking                  │
                                         │  • Heading-aware chunking        │
                                         └──────────────────────────────────┘
```

Each `execute` call spawns an isolated subprocess. Only stdout enters context. Everything else stays in the sandbox.

### `execute` — Run code, return summary

Execute code in 10 languages. Only printed output reaches Claude.

```
execute({ language: "shell", code: "gh pr list --json title,state | jq length" })
→ "3"                                           ← 2 bytes instead of 8KB
```

Add `intent` for large outputs — Context Mode indexes the output and returns only matching sections:

```
execute({ language: "shell", code: "cat app.log", intent: "database connection error" })
→ matching sections + searchable terms           ← 500B instead of 100KB
```

### `execute_file` — Process files without loading

File contents stay in the sandbox as `FILE_CONTENT`. Your code summarizes. Only the summary enters context.

```
execute_file({ path: "access.log", language: "python", code: "..." })
→ "200: 312 | 404: 89 | 500: 14"                ← 30 bytes instead of 45KB
```

### `index` + `search` — Searchable knowledge base

Index documentation into SQLite FTS5. Search returns exact code blocks with BM25 ranking — not summaries.

```
index({ content: <60KB React docs>, source: "React useEffect" })
→ "Indexed 33 sections (15 with code)"           ← 40 bytes

search({ query: "useEffect cleanup function" })
→ exact code example with heading context        ← 500 bytes instead of 60KB
```

### `fetch_and_index` — Fetch URLs into knowledge base

Fetches, converts HTML to markdown, indexes. Raw content never enters context.

```
fetch_and_index({ url: "https://react.dev/reference/react/useEffect" })
→ "Indexed 33 sections (15 with code)"           ← 40 bytes instead of 60KB
```

## Benchmarks

| Operation | Raw | Context | Savings |
|---|---|---|---|
| Playwright `browser_snapshot` | 56.2 KB | 299 B | **99%** |
| GitHub Issues (20) | 58.9 KB | 1.1 KB | **98%** |
| Access log (500 requests) | 45.1 KB | 155 B | **100%** |
| Context7 React docs | 5.9 KB | 261 B | **96%** |
| Analytics CSV (500 rows) | 85.5 KB | 222 B | **100%** |
| Git log (153 commits) | 11.6 KB | 107 B | **99%** |
| Test output (30 suites) | 6.0 KB | 337 B | **95%** |

| Metric | Without | With |
|---|---|---|
| Context consumed per session | 315 KB | 5.4 KB |
| Time before slowdown | ~30 min | ~3 hours |
| Context remaining after 45 min | 60% | 99% |

[Full benchmark data with 21 scenarios →](BENCHMARK.md)

## Example Prompts

Just ask naturally. Claude routes through Context Mode when it saves tokens.

```
"Analyze the last 50 commits and find the most frequently changed files"
"Read the access log and break down requests by HTTP status code"
"Run the test suite and give me a pass/fail summary"
"Fetch the React useEffect docs and find the cleanup pattern"
"Analyze package-lock.json and find the 10 largest dependencies"
```

## Requirements

- **Node.js 18+**
- **Claude Code** with MCP support
- Optional: Bun (auto-detected, 3-5x faster JS/TS)

## Development

```bash
git clone https://github.com/mksglu/claude-context-mode.git
cd claude-context-mode && npm install
npm test              # run tests
npm run test:all      # full suite
```

## License

MIT
