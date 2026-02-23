# Context Mode

**Claude Code MCP plugin that saves 94% of your context window.**

Every tool call in Claude Code consumes context tokens. A single Playwright snapshot burns 10K-135K tokens. A Context7 docs lookup dumps 4K-10K tokens. GitHub's `list_commits` with 30 results costs 29K-64K tokens. With 5+ MCP servers active, you lose ~55K tokens before your first message — and after 30 minutes of real debugging, responses slow to a crawl.

Context Mode intercepts these operations, processes data in isolated subprocesses, and returns only what matters.

## The Problem: MCP Context Bloat

Claude Code has a 200K token context window. Here's how fast popular MCP servers eat through it:

| MCP Server | Tool | Without Context Mode | With Context Mode | Savings | Source |
|---|---|---|---|---|---|
| **Playwright** | `browser_snapshot` | 10K-135K tokens | ~20 tokens | **99%** | [playwright-mcp#1233](https://github.com/microsoft/playwright-mcp/issues/1233) |
| **Context7** | `query-docs` | 4K-10K tokens | ~70 tokens | **98%** | [upstash/context7](https://github.com/upstash/context7) |
| **GitHub** | `list_commits` (30) | 29K-64K tokens | ~10 tokens | **99%** | [github-mcp-server#142](https://github.com/github/github-mcp-server/issues/142) |
| **Sentry** | issue analysis | 5K-30K tokens | ~25 tokens | **99%** | [getsentry/sentry-mcp](https://github.com/getsentry/sentry-mcp) |
| **Supabase** | schema queries | 2K-30K tokens | ~30 tokens | **99%** | [supabase-community/supabase-mcp](https://github.com/supabase-community/supabase-mcp) |
| **Firecrawl** | `scrape` / `crawl` | 5K-50K+ tokens | ~70 tokens | **99%** | [firecrawl](https://github.com/mendableai/firecrawl) |
| **Chrome DevTools** | DOM / network | 5K-50K+ tokens | ~25 tokens | **99%** | Community benchmark |
| **Fetch** | `fetch` | 5K-50K tokens | ~70 tokens | **99%** | Official reference server |

**Real measurement** ([Scott Spence, 2025](https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code)): With 81+ MCP tools enabled across multiple servers, **143K of 200K tokens (72%) consumed** — 82K tokens just for MCP tool definitions. Only 28% left for actual work.

**Vercel's finding** ([December 2025](https://www.anthropic.com/engineering/advanced-tool-use)): Removing 80% of tools resulted in 3.5x faster execution, 37% fewer tokens, and 100% success rate (up from 80%).

## Before / After

| What you're doing | Without Context Mode | With Context Mode | Savings |
|---|---|---|---|
| Playwright `browser_snapshot` | 12 KB into context | 50 B summary | **99%** |
| Context7 `query-docs` (React) | 60 KB raw docs | 285 B search result | **99%** |
| `gh pr list` / `gh api` | 8 KB JSON response | 40 B summary | **99%** |
| Read `access.log` (500 req) | 45 KB raw log | 71 B status breakdown | **99%** |
| `npm test` (30 suites) | 6 KB raw output | 37 B pass/fail | **99%** |
| Git log (153 commits) | 12 KB raw log | 18 B summary | **99%** |
| Supabase Edge Functions docs | 4 KB raw docs | 123 B code example | **97%** |

**Real aggregate across 13 scenarios: 194 KB raw → 12.6 KB context (94% savings)**

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

Authenticated CLIs work out of the box — `gh`, `aws`, `gcloud`, `kubectl`, `docker` credentials are passed through securely. Bun auto-detected for 3-5x faster JS/TS.

### `execute_file` — Process Files Without Loading

File contents never enter context. The file is read into a `FILE_CONTENT` variable inside the sandbox.

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
│ Claude Code → Playwright snapshot → 12KB into context            │
│ Claude Code → Context7 docs      → 60KB into context             │
│ Claude Code → gh pr list         →  8KB into context             │
│ Claude Code → cat access.log     → 45KB into context             │
│                                                                  │
│ Total: 125KB consumed = ~32,000 tokens = 16% of context gone     │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ With Context Mode                                                │
│                                                                  │
│ Claude Code → fetch_and_index(url)  → "Indexed 8 sections" (50B)│
│ Claude Code → search("snapshot")    → exact element       (500B) │
│ Claude Code → execute("gh pr list") → "3 open PRs"         (40B)│
│ Claude Code → execute_file(log)     → "500:14, 404:89"     (30B)│
│                                                                  │
│ Total: 620B consumed = ~160 tokens = 0.08% of context            │
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
                                         │  │ • Smart truncation     │  │
                                         │  └────────────────────────┘  │
                                         │                              │
                                         │  ┌────────────────────────┐  │
                                         │  │ ContentStore           │  │
                                         │  │ • SQLite FTS5          │  │
                                         │  │ • BM25 ranking         │  │
                                         │  │ • Porter stemming      │  │
                                         │  │ • Heading-aware chunks │  │
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

### Smart Truncation

When subprocess output exceeds the 100KB buffer, Context Mode preserves both head and tail:

```
Head (60%): Initial output with context
... [47 lines / 3.2KB truncated — showing first 12 + last 8 lines] ...
Tail (40%): Final output with errors/results
```

Line-boundary snapping — never cuts mid-line. Error messages at the bottom are always preserved.

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
| Playwright page snapshot | `execute_file` | 50+ KB | 78 B | **99%** |
| Context7 React docs | `index + search` | 5.9 KB | 285 B | **95%** |
| Context7 Supabase docs | `index + search` | 3.9 KB | 123 B | **97%** |
| Context7 Next.js docs | `index + search` | 6.5 KB | 273 B | **96%** |
| httpbin.org API docs | `fetch_and_index` | 9.4 KB | 50 B | **99%** |
| GitHub API response | `execute` | 8+ KB | 40 B | **99%** |
| Access log (500 req) | `execute_file` | 45.1 KB | 71 B | **100%** |
| Analytics CSV (500 rows) | `execute_file` | 85.5 KB | 11.5 KB | **87%** |
| MCP tools manifest (40 tools) | `execute_file` | 17.0 KB | 78 B | **100%** |
| npm test (30 suites) | `execute_file` | 6.0 KB | 37 B | **99%** |
| Git log (153 commits) | `execute` | 11.6 KB | 18 B | **100%** |

### Session Impact

Typical 45-minute debugging session:

| Metric | Without | With | Delta |
|---|---|---|---|
| Context consumed | 177 KB | 10 KB | **-94%** |
| Tokens used | ~45,300 | ~2,600 | **-94%** |
| Context remaining | 77% | 95% | **+18pp** |
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

113 tests across 3 suites:

| Suite | Tests | Coverage |
|---|---|---|
| Executor | 55 | 10 languages, sandbox, truncation, concurrency, timeouts |
| ContentStore | 34 | FTS5 schema, BM25 ranking, chunking, stemming, fixtures |
| MCP Integration | 24 | JSON-RPC protocol, all 5 tools, fetch_and_index, errors |

## Development

```bash
git clone https://github.com/mksglu/claude-context-mode.git
cd claude-context-mode
npm install
npm run build
npm test              # executor (55 tests)
npm run test:store    # FTS5/BM25 (34 tests)
npm run test:all      # all suites (113 tests)
```

## License

MIT
