# Context Mode — Benchmark Results

> Benchmarked against **real outputs** from popular Claude Code MCP servers, Skills, and dev tools.
> All fixtures captured from actual tool invocations — not synthetic data.

## Overview

| Metric | Value |
|--------|-------|
| Total scenarios | 21 |
| Tools benchmarked | `execute_file` (summarize) + `index`/`search` (knowledge retrieval) |
| Smart truncation | Head + tail preservation (60/40 split) |
| Total raw data processed | 376 KB |
| Total context consumed | 16.5 KB |
| Overall context savings | **96%** |
| Code examples preserved | **100%** (exact, not summarized) |

## Tool Decision Matrix

| Data Type | Best Tool | Why |
|-----------|-----------|-----|
| Documentation, API refs | `index` + `search` | Need exact code examples — not summaries |
| Skills prompts | `index` + `search` | Large prompts eat context; search on-demand |
| MCP tool signatures | `index` + `search` | Need exact tool names and parameters |
| Log files, test output | `execute_file` | Need aggregate stats, not raw lines |
| CSV data, analytics | `execute_file` | Need computed metrics |
| Build output | `execute_file` | Need error counts, not full logs |
| Browser snapshots | `execute_file` | Need page structure summary |

## Part 1: `execute_file` — Structured Data Processing

*Best for: logs, test output, CSV, build output — data where summaries are more useful than raw content.*

| Scenario | Source | Raw Size | Context | Savings | Time |
|----------|--------|----------|---------|---------|------|
| React useEffect docs | Context7 | 5.9 KB | 261 B | 96% | 18ms |
| Next.js App Router docs | Context7 | 6.5 KB | 249 B | 96% | 18ms |
| Tailwind CSS docs | Context7 | 4.0 KB | 186 B | 95% | 18ms |
| Page snapshot (Hacker News) | Playwright | 56.2 KB | 299 B | 99% | 16ms |
| Network requests | Playwright | 0.4 KB | 349 B | 13% | 16ms |
| PR list (vercel/next.js) | GitHub | 6.4 KB | 719 B | 89% | 16ms |
| Issues (facebook/react) | GitHub | 58.9 KB | 1,139 B | 98% | 16ms |
| Test output (30 suites) | vitest | 6.0 KB | 337 B | 95% | 16ms |
| TypeScript errors (50) | tsc | 4.9 KB | 347 B | 93% | 16ms |
| Build output (100+ lines) | next build | 6.4 KB | 405 B | 94% | 16ms |
| MCP tools (40 tools) | MCP tools/list | 17.0 KB | 742 B | 96% | 15ms |
| Access log (500 requests) | nginx | 45.1 KB | 155 B | 100% | 17ms |
| Git log (150+ commits) | git | 11.6 KB | 107 B | 99% | 16ms |
| Analytics CSV (500 rows) | analytics | 85.5 KB | 222 B | 100% | 32ms |

**Subtotal: 315 KB raw → 5.5 KB context (98% savings)**

## Part 2: `index` + `search` — Knowledge Retrieval (FTS5 BM25)

*Best for: documentation, code examples, API references, Skills — content where you need EXACT text, not summaries.*

| Scenario | Source | Raw Size | Search Result (3 queries) | Savings | Chunks | Code Blocks |
|----------|--------|----------|---------------------------|---------|--------|-------------|
| Supabase Edge Functions | Context7 | 3.9 KB | 2,246 B | 44% | 5 | 4 |
| React useEffect docs | Context7 | 5.9 KB | 1,494 B | 75% | 16 | 4 |
| Next.js App Router docs | Context7 | 6.5 KB | 3,311 B | 50% | 5 | 5 |
| Tailwind CSS docs | Context7 | 4.0 KB | 620 B | 85% | 5 | 5 |
| Skill prompt (main) | context-mode | 4.4 KB | 932 B | 79% | 15 | 6 |
| Skill references (4 files) | context-mode | 33.2 KB | 2,412 B | 93% | 51 | 32 |

**Subtotal: 60.3 KB raw → 11.0 KB context (82% savings)**

**Key difference from `execute_file`:** Code examples are returned **exactly as written** — not summarized. A `useEffect` cleanup pattern comes back with the full code block intact.

### Why `index + search` savings are lower

`execute_file` achieves 95-100% savings because it compresses data into 1-2 line summaries. `index + search` achieves 50-93% savings because it returns **complete, exact chunks** — the actual code examples, not descriptions of them. This is by design:

- `execute_file` on React docs: `"5 code blocks, 3 sections about cleanup"` → **useless for coding**
- `index + search` on React docs: returns the full `useEffect(() => { ... }, [deps])` block → **actually useful**

## Part 3: Smart Truncation

*When output exceeds the limit, context-mode keeps the first 60% + last 40% of lines — preserving both initial context and final error messages.*

| Before (v0.2) | After (v0.3) |
|---|---|
| Blindly keeps first N bytes | Keeps head (60%) + tail (40%) |
| Cuts mid-line, corrupts UTF-8 | Snaps to line boundaries |
| Error messages at end: **LOST** | Error messages at end: **PRESERVED** |
| `"... [output truncated]"` | `"[47 lines / 3.2KB truncated — showing first 12 + last 8 lines]"` |

### Example

```
line 0: data initialization
line 1: loading config
line 2: starting server
...

... [47 lines / 3.2KB truncated — showing first 12 + last 8 lines] ...

line 92: connection timeout
line 93: retry attempt 3 failed
line 94: FATAL: database unreachable
line 95: Stack trace: Error at connect()
line 96: exit code: 1
```

The LLM can now see **both** the setup context (head) and the actual error (tail).

## Context Window Impact

Claude's context window: **200,000 tokens**

### Scenario: Full debugging session

| Tool Calls | Without context-mode | With context-mode |
|---|---|---|
| Context7 docs (3 queries) | 16.4 KB | 5.6 KB |
| Playwright snapshot | 56.2 KB | 299 B |
| GitHub issues | 58.9 KB | 1,139 B |
| Test output | 6.0 KB | 337 B |
| Build output | 6.4 KB | 405 B |
| Skill prompt | 33.2 KB | 2.4 KB |
| **Total** | **177.1 KB** | **10.2 KB** |
| **Tokens** | **~45,300** | **~2,600** |
| **Context used** | **22.7%** | **1.3%** |

**Result: 94% more context available for actual problem solving.**

## Test Suite

| Suite | Tests | Status |
|-------|-------|--------|
| Executor (10 languages + edge cases) | 55 | All pass |
| ContentStore (FTS5 BM25) | 34 | All pass |
| MCP Integration (JSON-RPC) | 22 | All pass |
| Ecosystem Benchmark (14 scenarios) | 14 | All pass |
| **Total** | **125** | **All pass** |

## How to Reproduce

```bash
# Run individual test suites
npm run test              # Executor tests
npm run test:store        # FTS5 BM25 store tests
npm run test:ecosystem    # Ecosystem benchmark

# Run all tests
npm run test:all

# Live benchmark (requires Context7 fixture)
npx tsx tests/live-benchmark.ts
```

## Fixtures

All fixtures in `tests/fixtures/` are captured from real tool invocations:

| Fixture | Source | Size |
|---------|--------|------|
| `context7-react-docs.md` | Context7 MCP — React useEffect | 5.9 KB |
| `context7-nextjs-docs.md` | Context7 MCP — Next.js App Router | 6.5 KB |
| `context7-tailwind-docs.md` | Context7 MCP — Tailwind CSS | 4.0 KB |
| `context7-supabase-edge.md` | Context7 MCP — Supabase Edge Functions | 3.9 KB |
| `playwright-snapshot.txt` | Playwright MCP — page snapshot | 56.2 KB |
| `playwright-network.txt` | Playwright MCP — network requests | 0.4 KB |
| `github-prs.json` | `gh pr list --repo vercel/next.js` | 6.4 KB |
| `github-issues.json` | `gh issue list --repo facebook/react` | 58.9 KB |
| `test-output.txt` | vitest run (30 suites) | 6.0 KB |
| `tsc-errors.txt` | tsc --noEmit (50 errors) | 4.9 KB |
| `build-output.txt` | next build output | 6.4 KB |
| `mcp-tools.json` | MCP tools/list (40 tools) | 17.0 KB |
| `access.log` | nginx access log (500 requests) | 45.1 KB |
| `git-log.txt` | git log --oneline (153 commits) | 11.6 KB |
| `analytics.csv` | Event analytics (500 rows) | 85.5 KB |
