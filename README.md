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
<summary><strong>Plugin install</strong> (includes auto-routing skill + subagent hook)</summary>

```bash
/plugin marketplace add mksglu/claude-context-mode
/plugin install context-mode@claude-context-mode
```

Installs the MCP server + a skill that automatically routes large outputs through Context Mode + a PreToolUse hook that injects context-mode routing into subagent prompts. No prompting needed.

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
| `batch_execute` | Run multiple commands + search multiple queries in ONE call. | 986 KB → 62 KB |
| `execute` | Run code in 10 languages. Only stdout enters context. | 56 KB → 299 B |
| `execute_file` | Process files in sandbox. Raw content never leaves. | 45 KB → 155 B |
| `index` | Chunk markdown into FTS5 with BM25 ranking. | 60 KB → 40 B |
| `search` | Query indexed content with multiple queries in one call. | On-demand retrieval |
| `fetch_and_index` | Fetch URL, convert to markdown, index. | 60 KB → 40 B |
| `stats` | Session token tracking with per-tool breakdown. | — |

## How the Sandbox Works

Each `execute` call spawns an isolated subprocess with its own process boundary. Scripts can't access each other's memory or state. The subprocess runs your code, captures stdout, and only that stdout enters the conversation context. The raw data — log files, API responses, snapshots — never leaves the sandbox.

Ten language runtimes are available: JavaScript, TypeScript, Python, Shell, Ruby, Go, Rust, PHP, Perl, R. Bun is auto-detected for 3-5x faster JS/TS execution.

Authenticated CLIs work through credential passthrough — `gh`, `aws`, `gcloud`, `kubectl`, `docker` inherit environment variables and config paths without exposing them to the conversation.

When output exceeds 5 KB and an `intent` is provided, Context Mode switches to intent-driven filtering: it indexes the full output into the knowledge base, searches for sections matching your intent, and returns only the relevant matches with a vocabulary of searchable terms for follow-up queries.

## How the Knowledge Base Works

The `index` tool chunks markdown content by headings while keeping code blocks intact, then stores them in a **SQLite FTS5** (Full-Text Search 5) virtual table. Search uses **BM25 ranking** — a probabilistic relevance algorithm that scores documents based on term frequency, inverse document frequency, and document length normalization. **Porter stemming** is applied at index time so "running", "runs", and "ran" match the same stem.

When you call `search`, it returns relevant content snippets focused around matching query terms — not full documents, not approximations, the actual indexed content with smart extraction around what you're looking for. `fetch_and_index` extends this to URLs: fetch, convert HTML to markdown, chunk, index. The raw page never enters context.

## Smart Snippets

Search results use intelligent extraction instead of truncation. Instead of returning the first N characters (which might miss the important part), Context Mode finds where your query terms appear in the content and returns windows around those matches. If your query is "authentication JWT token", you get the paragraphs where those terms actually appear — not an arbitrary prefix.

## Progressive Search Throttling

The `search` tool includes progressive throttling to prevent context flooding from excessive individual calls:

- **Calls 1-3:** Normal results (2 per query)
- **Calls 4-8:** Reduced results (1 per query) + warning
- **Calls 9+:** Blocked — redirects to `batch_execute`

This encourages batching queries via `search(queries: ["q1", "q2", "q3"])` or `batch_execute` instead of making dozens of individual calls.

## Session Stats

The `stats` tool tracks context consumption in real-time. Useful for debugging context usage during long sessions.

```
Session uptime:                 2.6 min
Tool calls:                     5
Bytes returned to context:      62.0 KB (~15.9k tokens)
Bytes indexed (stayed in sandbox): 140.5 KB
Context savings ratio:          2.3x (56% reduction)

Per-tool breakdown:
  batch_execute    4 calls    58.2 KB
  search           1 call      3.8 KB
```

## Subagent Routing

When installed as a plugin, Context Mode includes a PreToolUse hook that automatically injects routing instructions into subagent (Task tool) prompts. Subagents learn to use `batch_execute` as their primary tool and `search(queries: [...])` for follow-ups — without any manual configuration.

## The Numbers

Measured across real-world scenarios:

**Playwright snapshot** — 56.2 KB raw → 299 B context (99% saved)
**GitHub Issues (20)** — 58.9 KB raw → 1.1 KB context (98% saved)
**Access log (500 requests)** — 45.1 KB raw → 155 B context (100% saved)
**Context7 React docs** — 5.9 KB raw → 261 B context (96% saved)
**Analytics CSV (500 rows)** — 85.5 KB raw → 222 B context (100% saved)
**Git log (153 commits)** — 11.6 KB raw → 107 B context (99% saved)
**Test output (30 suites)** — 6.0 KB raw → 337 B context (95% saved)
**Repo research (subagent)** — 986 KB raw → 62 KB context (94% saved, 5 calls vs 37)

Over a full session: 315 KB of raw output becomes 5.4 KB. Session time before slowdown goes from ~30 minutes to ~3 hours. Context remaining after 45 minutes: 99% instead of 60%.

[Full benchmark data with 21 scenarios →](BENCHMARK.md)

## Try It

These prompts work out of the box. Claude routes through Context Mode automatically.

**Git history analysis**
```
Clone https://github.com/modelcontextprotocol/servers and analyze its git history:
top contributors, commit types (feat/fix/docs/chore), and busiest weeks.
```

**Web page extraction**
```
Fetch the Hacker News front page and extract: top 15 posts with titles, scores,
comment counts, and domains. Group them by domain.
```

**Documentation lookup**
```
Fetch the React useEffect docs and find the cleanup pattern.
```

**Monorepo dependency audit**
```
Analyze package-lock.json: find the 10 largest dependencies,
which packages share the most common deps, and the heaviest package by count.
```

**Parallel browser + docs analysis**
```
Run 3 parallel tasks:
1. Navigate to news.ycombinator.com, take a snapshot, count all links and interactive elements
2. Navigate to jsonplaceholder.typicode.com, extract all API endpoint paths and HTTP methods
3. Fetch the Anthropic prompt caching docs, search for cache TTL and token pricing
Present all findings in a comparison table.
```

**Deep repo research**
```
Research the following repository: https://github.com/vercel-labs/agent-browser
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
