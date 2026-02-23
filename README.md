# Context Mode

**Claude Code MCP plugin that saves 98% of your context window.**

Every tool call in Claude Code consumes context tokens. A single Playwright snapshot burns 10K-135K tokens. A Context7 docs lookup dumps 4K-10K tokens. GitHub's `list_commits` with 30 results costs 29K-64K tokens. With 5+ MCP servers active, you lose ~55K tokens before your first message — and after 30 minutes of real debugging, responses slow to a crawl.

Context Mode intercepts these operations, processes data in isolated subprocesses, and returns only what matters.

## The Problem: MCP Context Bloat

Claude Code has a 200K token context window. Here's how fast popular MCP servers eat through it:

| MCP Server | Tool | Without Context Mode | With Context Mode | Savings | Source |
|---|---|---|---|---|---|
| **Playwright** | `browser_snapshot` | 10K-135K tokens | ~75 tokens | **99%** | [playwright-mcp#1233](https://github.com/microsoft/playwright-mcp/issues/1233) |
| **Context7** | `query-docs` | 4K-10K tokens | ~65 tokens | **98%** | [upstash/context7](https://github.com/upstash/context7) |
| **GitHub** | `list_commits` (30) | 29K-64K tokens | ~180 tokens | **99%** | [github-mcp-server#142](https://github.com/github/github-mcp-server/issues/142) |
| **Sentry** | issue analysis | 5K-30K tokens | ~85 tokens | **99%** | [getsentry/sentry-mcp](https://github.com/getsentry/sentry-mcp) |
| **Supabase** | schema queries | 2K-30K tokens | ~80 tokens | **99%** | [supabase-community/supabase-mcp](https://github.com/supabase-community/supabase-mcp) |
| **Firecrawl** | `scrape` / `crawl` | 5K-50K+ tokens | ~65 tokens | **99%** | [firecrawl](https://github.com/mendableai/firecrawl) |
| **Chrome DevTools** | DOM / network | 5K-50K+ tokens | ~75 tokens | **99%** | Community benchmark |
| **Fetch** | `fetch` | 5K-50K tokens | ~65 tokens | **99%** | Official reference server |

**Real measurement** ([Scott Spence, 2025](https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code)): With 81+ MCP tools enabled across multiple servers, **143K of 200K tokens (72%) consumed** — 82K tokens just for MCP tool definitions. Only 28% left for actual work.

**Vercel's finding** ([December 2025](https://www.anthropic.com/engineering/advanced-tool-use)): Removing 80% of tools resulted in 3.5x faster execution, 37% fewer tokens, and 100% success rate (up from 80%).

## Before / After

| What you're doing | Without Context Mode | With Context Mode | Savings |
|---|---|---|---|
| Playwright `browser_snapshot` | 56 KB into context | 299 B summary | **99%** |
| Context7 `query-docs` (React) | 5.9 KB raw docs | 261 B summary | **96%** |
| GitHub issues (20) | 59 KB JSON response | 1.1 KB summary | **98%** |
| Read `access.log` (500 req) | 45 KB raw log | 155 B status breakdown | **100%** |
| `vitest` (30 suites) | 6 KB raw output | 337 B pass/fail | **95%** |
| Git log (153 commits) | 12 KB raw log | 107 B summary | **99%** |
| Analytics CSV (500 rows) | 86 KB raw data | 222 B summary | **100%** |

**Real aggregate across 14 scenarios: 315 KB raw → 5.4 KB context (98% savings)**

## Quick Start

### Option 1: Claude Code Plugin (Recommended)

```bash
/plugin marketplace add mksglu/claude-context-mode
/plugin install context-mode@claude-context-mode
```

Installs as a Claude Code plugin with MCP server + skills bundled. The skill automatically guides Claude to route large outputs through Context Mode.

### Option 2: MCP Server Only

```bash
claude mcp add context-mode -- npx -y context-mode
```

Restart Claude Code. 5 tools are now available.

### Option 3: Local Development

```bash
claude --plugin-dir ./path/to/context-mode
```

## Tools

### `execute` — Run Code in Sandbox

Execute code in 10 languages: JavaScript, TypeScript, Python, Shell, Ruby, Go, Rust, PHP, Perl, R. Only stdout enters context — raw data stays in the subprocess.

```
Claude calls: execute({ language: "shell", code: "gh pr list --json title,state | jq length" })
Returns: "3"                  ← 2 bytes instead of 8KB JSON
```

**Intent-driven search** (v0.5.2): When you provide an `intent` parameter and output exceeds 5KB, Context Mode uses score-based BM25 search to return only the relevant sections matching your intent.

```
Claude calls: execute({
  language: "shell",
  code: "cat /var/log/app.log",
  intent: "connection refused database error"
})
Returns: section titles + searchable terms (500B) ← instead of 100KB raw log
```

When intent search runs, the response includes `Searchable terms` — distinctive vocabulary
extracted from the output via IDF scoring. Use these terms for targeted follow-up `search()` calls.

Authenticated CLIs work out of the box — `gh`, `aws`, `gcloud`, `kubectl`, `docker` credentials are passed through securely. Bun auto-detected for 3-5x faster JS/TS.

### `execute_file` — Process Files Without Loading

File contents never enter context. The file is read into a `FILE_CONTENT` variable inside the sandbox. Also supports `intent` parameter for intent-driven search on large outputs.

```
Claude calls: execute_file({ path: "access.log", language: "python", code: "..." })
Returns: "200: 312 | 404: 89 | 500: 14"     ← 30 bytes instead of 45KB
```

### `index` — Build Searchable Knowledge Base

Chunks markdown by headings, keeps code blocks intact, stores in ephemeral FTS5 database with BM25 ranking.

```
Claude calls: index({ content: <60KB React docs>, source: "React useEffect" })
Returns: "Indexed 33 sections (15 with code)"     ← 40 bytes
```

### `search` — Retrieve Exact Content

BM25 full-text search with Porter stemming. Returns exact code blocks — not summaries.

```
Claude calls: search({ query: "useEffect cleanup function" })
Returns: exact code example with heading context     ← 500 bytes instead of 60KB
```

### `fetch_and_index` — Fetch & Index URLs

Fetches URL in subprocess, converts HTML to markdown, indexes into FTS5. Raw content never enters context.

```
Claude calls: fetch_and_index({ url: "https://react.dev/reference/react/useEffect" })
Returns: "Indexed 33 sections (15 with code)"     ← 40 bytes instead of 60KB
```

Use instead of WebFetch or Context7 when you need documentation — index once, search many times.

## How It Works

```
┌──────────────────────────────────────────────────────────────────┐
│ Without Context Mode                                             │
│                                                                  │
│ Claude Code → Playwright snapshot → 56KB into context            │
│ Claude Code → Context7 docs      →  6KB into context             │
│ Claude Code → gh pr list         →  6KB into context             │
│ Claude Code → cat access.log     → 45KB into context             │
│                                                                  │
│ Total: 113KB consumed = ~29,000 tokens = 14% of context gone     │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ With Context Mode                                                │
│                                                                  │
│ Claude Code → fetch_and_index(url)  → "Indexed 8 sections" (50B)│
│ Claude Code → search("snapshot")    → exact element       (500B) │
│ Claude Code → execute("gh pr list") → "5 PRs, +59 -0"    (719B)│
│ Claude Code → execute_file(log)     → "500:13, 404:13"    (155B)│
│                                                                  │
│ Total: 1.4KB consumed = ~350 tokens = 0.18% of context           │
└──────────────────────────────────────────────────────────────────┘
```

## Architecture

```
┌─────────────┐    stdio / JSON-RPC     ┌──────────────────────────────┐
│             │ ◄──────────────────────► │  Context Mode MCP Server     │
│ Claude Code │    tool calls/results    │                              │
│             │                          │  ┌────────────────────────┐  │
└─────────────┘                          │  │ PolyglotExecutor       │  │
                                         │  │ • 10 language runtimes │  │
                                         │  │ • Sandboxed subprocess │  │
                                         │  │ • Auth passthrough     │  │
                                         │  │ • Intent-driven search │  │
                                         │  └────────────────────────┘  │
                                         │                              │
                                         │  ┌────────────────────────┐  │
                                         │  │ ContentStore           │  │
                                         │  │ • SQLite FTS5          │  │
                                         │  │ • BM25 ranking         │  │
                                         │  │ • Porter stemming      │  │
                                         │  │ • Heading-aware chunks │  │
                                         │  │ • Vocabulary hints     │  │
                                         │  └────────────────────────┘  │
                                         └──────────────────────────────┘
```

### Sandbox Isolation

Each `execute` call spawns an isolated subprocess with:

- **Isolated temp directory** per execution — scripts can't access each other
- **Real HOME** — so `gh`, `aws`, `gcloud` find their auth configs
- **Auth passthrough** — GH_TOKEN, AWS credentials, KUBECONFIG, Docker, npm tokens, XDG paths
- **Clean environment** — PATH, LANG, NO_COLOR, Python unbuffered mode

### FTS5 Knowledge Base

The `index` and `search` tools use SQLite FTS5 with BM25 ranking:

```sql
CREATE VIRTUAL TABLE chunks USING fts5(
  title,                        -- heading hierarchy, weighted 2x
  content,                      -- section text + code blocks
  source_id UNINDEXED,
  content_type UNINDEXED,       -- "code" or "prose"
  tokenize='porter unicode61'   -- stemming + unicode support
);

SELECT title, content, bm25(chunks, 2.0, 1.0) AS rank
FROM chunks
WHERE chunks MATCH ?
ORDER BY rank LIMIT 3;
```

**Chunking algorithm:**
- Splits on H1-H4 headings and `---` separators
- Tracks heading hierarchy: `"React > Hooks > useEffect > Cleanup"`
- Keeps code blocks intact — never splits mid-block
- Marks chunks as `code` or `prose` for content-type filtering
- Porter stemming: "connecting" matches "connect", "connection", "connected"

**Lazy singleton:** Database created only when `index` or `search` is first called — zero overhead for sessions that don't use it.

### Intent-Driven Search (v0.5.2)

When `execute` or `execute_file` is called with an `intent` parameter and output exceeds 5KB, Context Mode uses score-based BM25 search to return only the relevant sections:

- **Score-based search**: Searches ALL intent words independently, ranks chunks by match count
- **Searchable terms**: Distinctive vocabulary hints extracted via IDF scoring, helping you craft precise follow-up `search()` calls
- **Smarter chunk titles**: Uses the first content line of each chunk instead of generic "Section N" labels

```
Without intent:
  stdout (100KB) → full output enters context

With intent:
  stdout (100KB) → chunk by lines → in-memory FTS5 → score all intent words → top chunks + searchable terms
  Result: only what you need enters context, plus vocabulary for targeted follow-ups
```

**31% to 100% recall on real-world CHANGELOG test** — the score-based approach finds every relevant section, not just those matching a single query string.

Tested across 5 real-world scenarios:

| Scenario | Without Intent | With Intent | Size Reduction |
|---|---|---|---|
| Server log error (line 347/500) | error lost in output | **found** | 1.5 KB vs 5.0 KB |
| 3 test failures among 200 tests | only 2/3 visible | **all 3 found** | 2.4 KB vs 5.0 KB |
| 2 build warnings among 300 lines | both lost in output | **both found** | 2.1 KB vs 5.0 KB |
| API auth error (line 743/1000) | error lost in output | **found** | 1.2 KB vs 4.9 KB |
| Semantic gap (CHANGELOG search) | 31% recall | **100% recall** | Full coverage |

Intent search finds the target every time while using 50-75% fewer bytes.

### HTML to Markdown Conversion

`fetch_and_index` converts HTML in a subprocess (raw HTML never enters context):

1. Strip `<script>`, `<style>`, `<nav>`, `<header>`, `<footer>`
2. Convert `<h1>`-`<h4>` to `#`-`####` markdown headings
3. Convert `<pre><code>` to fenced code blocks with language detection
4. Convert `<a>`, `<li>`, `<p>`, `<br>`, `<hr>` to markdown
5. Decode HTML entities (`&amp;`, `&lt;`, `&nbsp;`, etc.)
6. Collapse excessive whitespace

## Benchmarks

### Real MCP Ecosystem Comparison

Tested with tools from popular MCP servers and Claude Code workflows:

| Scenario | Tool | Raw | Context | Savings |
|---|---|---|---|---|
| Playwright page snapshot | `execute` | 56.2 KB | 299 B | **99%** |
| Context7 React docs | `execute` | 5.9 KB | 261 B | **96%** |
| Context7 Next.js docs | `execute` | 6.5 KB | 249 B | **96%** |
| Context7 Tailwind docs | `execute` | 4.0 KB | 186 B | **95%** |
| GitHub Issues (20) | `execute` | 58.9 KB | 1.1 KB | **98%** |
| GitHub PR list (5) | `execute` | 6.4 KB | 719 B | **89%** |
| Access log (500 req) | `execute_file` | 45.1 KB | 155 B | **100%** |
| Analytics CSV (500 rows) | `execute_file` | 85.5 KB | 222 B | **100%** |
| MCP tools manifest (40 tools) | `execute_file` | 17.0 KB | 742 B | **96%** |
| Test output (30 suites) | `execute` | 6.0 KB | 337 B | **95%** |
| Git log (153 commits) | `execute` | 11.6 KB | 107 B | **99%** |

### Session Impact

Typical 45-minute debugging session:

| Metric | Without | With | Delta |
|---|---|---|---|
| Context consumed | 315 KB | 5.4 KB | **-98%** |
| Tokens used | ~80,600 | ~1,400 | **-98%** |
| Context remaining | 60% | 99% | **+39pp** |
| Time before slowdown | ~30 min | ~3 hours | **+6x** |

## Tool Decision Matrix

| Data Type | Best Tool | Why |
|---|---|---|
| Web documentation | `fetch_and_index` → `search` | Index once, search many times |
| MCP tool output (large) | `index` → `search` | Keep raw output out of context |
| Log files | `execute_file` | Aggregate stats |
| Test output | `execute_file` | Pass/fail summary |
| CSV / JSON data | `execute_file` | Computed metrics |
| Git / GitHub operations | `execute` | `gh`, `git` commands with auth |
| Cloud CLI | `execute` | `aws`, `gcloud`, `kubectl` with auth |
| Build output | `execute` | Error counts and warnings |
| Source code to edit | Plain `Read` tool | Need full content for edits |
| Small files (<20 lines) | Plain `Read` tool | Minimal overhead |

## Example Prompts

Just ask naturally — Claude automatically routes through Context Mode when it saves tokens.

### Git & GitHub

```
"Analyze the last 50 commits and find the most frequently changed files"
"List all open PRs on this repo and summarize their status"
"Show contributors ranked by commit count this month"
"Find all commits that touched the auth module in the last 30 days"
```

### Code Analysis

```
"Analyze all TypeScript files in src/ and report function counts per file"
"Find all TODO and FIXME comments across the codebase"
"Count lines of code per language in this project"
"List all exported functions from src/utils/ and their parameter signatures"
```

### Logs & Debugging

```
"Read the access log and break down requests by HTTP status code"
"Find the top 10 slowest API endpoints from the request log"
"Parse the error log and group exceptions by type with frequency"
"Analyze the build output and list all warnings with file locations"
```

### Test & CI

```
"Run the test suite and give me a pass/fail summary"
"Analyze test coverage output and find untested files"
"Check which tests have been flaky in the last 10 CI runs"
```

### Data & Config

```
"Analyze package-lock.json and find the 10 largest dependencies by size"
"Parse the CSV export and compute average response time per endpoint"
"Read the Kubernetes manifests and summarize resource limits per pod"
"Compare tsconfig.json across packages in this monorepo"
```

### Documentation Lookup

```
"Fetch the React useEffect docs and find the cleanup pattern"
"Index the Next.js App Router documentation and search for loading states"
"Look up the Zod docs and find string validation examples"
"Fetch the Tailwind docs and search for responsive breakpoint utilities"
```

### Cloud & Infrastructure

```
"List all S3 buckets and their sizes using AWS CLI"
"Show running Kubernetes pods and their restart counts"
"List all Docker containers with their memory and CPU usage"
"Check the status of all Cloudflare Workers in this account"
```

## Requirements

- **Node.js 18+**
- **Claude Code** with MCP support

### Auto-Detected Runtimes

| Runtime | Used For | Speed |
|---|---|---|
| Bun (optional) | JS/TS execution | 3-5x faster than Node |
| Python 3 | Python code | Standard |
| Ruby, Go, Rust, PHP, Perl, R | Respective languages | Standard |

## Test Suite

100+ tests across 4 suites:

| Suite | Tests | Coverage |
|---|---|---|
| Executor | 55 | 10 languages, sandbox, output handling, concurrency, timeouts |
| ContentStore | 40 | FTS5 schema, BM25 ranking, chunking, stemming, plain text indexing |
| Intent Search | 5 | Intent-driven search across 5 real-world scenarios (incl. semantic gap) |
| MCP Integration | 24 | JSON-RPC protocol, all 5 tools, fetch_and_index, errors |

## Development

```bash
git clone https://github.com/mksglu/claude-context-mode.git
cd claude-context-mode
npm install
npm run build
npm test              # executor (55 tests)
npm run test:store    # FTS5/BM25 (40 tests)
npm run test:all      # all suites (100+ tests)
```

## License

MIT
