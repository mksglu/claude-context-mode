# Context Mode

**The other half of the context problem.**

[![npm](https://img.shields.io/npm/v/context-mode)](https://www.npmjs.com/package/context-mode) [![marketplace](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmksglu%2Fclaude-context-mode%2Fmain%2F.claude-plugin%2Fmarketplace.json&query=%24.plugins%5B0%5D.version&label=marketplace&color=brightgreen)](https://github.com/mksglu/claude-context-mode) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Every MCP tool call in Claude Code dumps raw data into your 200K context window. A Playwright snapshot costs 56 KB. Twenty GitHub issues cost 59 KB. One access log — 45 KB. After 30 minutes, 40% of your context is gone.

Inspired by Cloudflare's [Code Mode](https://blog.cloudflare.com/code-mode-mcp/) — which compresses tool definitions from millions of tokens into ~1,000 — we asked: what about the other direction?

Context Mode is an MCP server that sits between Claude Code and these outputs. **315 KB becomes 5.4 KB. 98% reduction.**

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

## Tools

| Tool | What it does | Context saved |
|---|---|---|
| `execute` | Run code in 10 languages. Only stdout enters context. | 56 KB → 299 B |
| `execute_file` | Process files in sandbox. Raw content never leaves. | 45 KB → 155 B |
| `index` | Chunk markdown into FTS5 with BM25 ranking. | 60 KB → 40 B |
| `search` | Query indexed content. Returns exact code blocks. | On-demand retrieval |
| `fetch_and_index` | Fetch URL, convert to markdown, index. | 60 KB → 40 B |

## How the Sandbox Works

Each `execute` call spawns an isolated subprocess with its own process boundary. Scripts can't access each other's memory or state. The subprocess runs your code, captures stdout, and only that stdout enters the conversation context. The raw data — log files, API responses, snapshots — never leaves the sandbox.

Ten language runtimes are available: JavaScript, TypeScript, Python, Shell, Ruby, Go, Rust, PHP, Perl, R. Bun is auto-detected for 3-5x faster JS/TS execution.

Authenticated CLIs work through credential passthrough — `gh`, `aws`, `gcloud`, `kubectl`, `docker` inherit environment variables and config paths without exposing them to the conversation.

When output exceeds 5 KB and an `intent` is provided, Context Mode switches to intent-driven filtering: it indexes the full output into the knowledge base, searches for sections matching your intent, and returns only the relevant matches with a vocabulary of searchable terms for follow-up queries.

## How the Knowledge Base Works

The `index` tool chunks markdown content by headings while keeping code blocks intact, then stores them in a **SQLite FTS5** (Full-Text Search 5) virtual table. Search uses **BM25 ranking** — a probabilistic relevance algorithm that scores documents based on term frequency, inverse document frequency, and document length normalization. **Porter stemming** is applied at index time so "running", "runs", and "ran" match the same stem.

When you call `search`, it returns exact code blocks with their heading hierarchy — not summaries, not approximations, the actual indexed content. `fetch_and_index` extends this to URLs: fetch, convert HTML to markdown, chunk, index. The raw page never enters context.

## Benchmarks

| Operation | Raw output | After Context Mode | Savings |
|---|---|---|---|
| Playwright `browser_snapshot` | 56.2 KB | 299 B | **99%** |
| GitHub Issues (20) | 58.9 KB | 1.1 KB | **98%** |
| Access log (500 requests) | 45.1 KB | 155 B | **100%** |
| Context7 React docs | 5.9 KB | 261 B | **96%** |
| Analytics CSV (500 rows) | 85.5 KB | 222 B | **100%** |
| Git log (153 commits) | 11.6 KB | 107 B | **99%** |
| Test output (30 suites) | 6.0 KB | 337 B | **95%** |

Validated across 11 real-world scenarios — test triage, TypeScript error diagnosis, git diff review, dependency audit, API response processing, CSV analytics. All under 1 KB output each.

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
