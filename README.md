# Context Mode

**Claude Code MCP plugin that saves 94% of your context window.**

Every MCP tool call, every `cat` of a log file, every documentation lookup eats into your 200K token context. Context Mode intercepts these operations, processes them in isolated subprocesses, and returns only what matters — keeping your context window clean for actual problem-solving.

## The Problem

A typical Claude Code debugging session burns through context fast:

| Operation | Without Context Mode | With Context Mode |
|-----------|---------------------|-------------------|
| Read access.log (500 req) | **45.1 KB** into context | **71 B** summary |
| Fetch React useEffect docs | **60.3 KB** raw HTML | **285 B** search result |
| `npm test` output (30 suites) | **6.0 KB** raw output | **37 B** pass/fail |
| Git log (153 commits) | **11.6 KB** raw log | **18 B** summary |
| **Total** | **123 KB** (~31K tokens) | **411 B** (~100 tokens) |

After 30 minutes, sessions hit context limits and degrade to 60s+ responses. Context Mode prevents this.

## Quick Start

```bash
claude mcp add-json context-mode '{"type":"stdio","command":"npx","args":["-y","context-mode"]}'
```

Restart Claude Code. Done. 5 tools are now available.

### Per-Project Setup (team-shared)

Add `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "context-mode": {
      "command": "npx",
      "args": ["-y", "context-mode"]
    }
  }
}
```

## Tools

### `execute` — Run Code in Sandbox

Runs code in an isolated subprocess. Only `stdout` enters context.

**10 languages:** JavaScript, TypeScript, Python, Shell, Ruby, Go, Rust, PHP, Perl, R

Authenticated CLI tools (`gh`, `aws`, `gcloud`, `kubectl`, `docker`) work out of the box — auth credentials are passed through securely.

When Bun is installed, JS/TS runs 3-5x faster automatically.

### `execute_file` — Process Files Without Loading

Reads a file into a `FILE_CONTENT` variable inside the sandbox. The file contents never enter context — only your printed summary does.

**Use for:** Log analysis, CSV aggregation, JSON inspection, test output parsing.

### `index` — Build a Knowledge Base

Indexes content into a searchable BM25 knowledge base. Chunks markdown by headings, keeps code blocks intact, stores in ephemeral FTS5 database.

**Use for:** API docs, framework guides, README files, any content with code examples.

### `search` — Retrieve Exact Content

BM25 full-text search across indexed content. Returns exact code blocks and documentation — not summaries.

### `fetch_and_index` — Fetch & Index URLs

Fetches a URL, converts HTML to markdown, and indexes into the knowledge base. Raw content never enters context.

**Use for:** Documentation lookups without burning context. Replaces WebFetch for docs you'll reference multiple times.

## How It Works

```
Without Context Mode:
  Claude Code → WebFetch docs    → 60KB raw HTML   → context fills up
  Claude Code → Bash npm test    → 50KB raw output  → context fills up
  Claude Code → gh pr list       → 20KB JSON        → context fills up

With Context Mode:
  Claude Code → fetch_and_index(url)     → "Indexed 8 sections"        (50B)
  Claude Code → execute("npm test")      → "132 pass, 8 fail"          (30B)
  Claude Code → execute("gh pr list")    → "3 open PRs: #42, #38, #35" (40B)
  Claude Code → search("useEffect")      → exact code block            (500B)
```

Data processing happens in subprocesses, not in the context window.

## Benchmarks

Measured across 13 real-world scenarios:

| Tool | Use Case | Raw | Context | Savings |
|------|----------|-----|---------|---------|
| `fetch_and_index` | API documentation | 9.4 KB | 50 B | **99%** |
| `execute` | Git log (153 commits) | 11.6 KB | 18 B | **100%** |
| `execute_file` | Access log (500 requests) | 45.1 KB | 71 B | **100%** |
| `execute_file` | Analytics CSV (500 rows) | 85.5 KB | 11.5 KB | **87%** |
| `execute_file` | MCP tools manifest (40 tools) | 17.0 KB | 78 B | **100%** |
| `index + search` | React docs → useEffect | 5.9 KB | 285 B | **95%** |
| `index + search` | Supabase Edge Functions | 3.9 KB | 123 B | **97%** |
| `index + search` | Next.js docs → routing | 6.5 KB | 273 B | **96%** |

**Aggregate: 194 KB raw → 12.6 KB context = 94% savings**

### Session Impact

| Metric | Without | With | Delta |
|--------|---------|------|-------|
| Context consumed | 177 KB | 10 KB | **-94%** |
| Estimated tokens | ~45,300 | ~2,600 | **-94%** |
| Window remaining | 77% | 95% | **+18pp** |

## Smart Truncation

When output exceeds the buffer, Context Mode keeps both the head (initial context) and tail (errors/results):

```
First 12 lines of output...
... [47 lines / 3.2KB truncated — showing first 12 + last 8 lines] ...
Last 8 lines with error messages
```

60% head + 40% tail, snapped to line boundaries.

## Tool Decision Matrix

| Data Type | Best Tool | Why |
|-----------|-----------|-----|
| Web documentation | `fetch_and_index` | Raw HTML never enters context |
| API references | `fetch_and_index` → `search` | Index once, search many times |
| Log files | `execute_file` | Aggregate stats |
| Test output | `execute_file` | Pass/fail summary |
| CSV / JSON data | `execute_file` | Computed metrics |
| Git operations | `execute` | `gh`, `git` commands work natively |
| Build output | `execute` | Error counts and warnings |
| Cloud CLI | `execute` | `aws`, `gcloud`, `kubectl` with auth |
| Source code to edit | Plain `Read` tool | Need full content |
| Small files (<20 lines) | Plain `Read` tool | Minimal overhead |

## Requirements

- **Node.js 18+**
- **Claude Code** with MCP support

### Optional Runtimes (auto-detected)

Bun (3-5x faster JS/TS), Python 3, Ruby, Go, Rust, PHP, Perl, R

## Architecture

```
┌─────────────┐    stdio / JSON-RPC     ┌──────────────────┐
│             │ ◄──────────────────────► │  Context Mode    │
│ Claude Code │    tool calls/results    │  MCP Server      │
│             │                          │                  │
└─────────────┘                          │  ┌────────────┐  │
                                         │  │ Executor   │  │
                                         │  │ 10 langs   │  │
                                         │  │ sandboxed  │  │
                                         │  └────────────┘  │
                                         │                  │
                                         │  ┌────────────┐  │
                                         │  │ ContentStore│  │
                                         │  │ SQLite FTS5│  │
                                         │  │ BM25 search│  │
                                         │  └────────────┘  │
                                         └──────────────────┘
```

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
