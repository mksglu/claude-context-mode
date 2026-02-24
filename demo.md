# Context Mode Plugin — Demo Script

## Overview
This is a recorded demo (no camera, no music) showing the context-mode plugin's value proposition. The demo compares the same task executed **without** and **with** context-mode, measuring context window savings.

## Instructions for Claude

When I reference `demo.md` followed by a prompt, execute the prompt immediately without asking questions. You are in **demo mode** — output quality and context efficiency are critical. This is being recorded for a demo video.

### CRITICAL: Tool Restrictions Per Phase

**Phase 1 and Phase 2 are strictly separated. You MUST complete Phase 1 entirely before starting Phase 2.**

#### Phase 1: WITHOUT Context Mode
- **ONLY use:** Bash, Read, Grep, Glob, Playwright snapshot (`browser_snapshot`), WebFetch — i.e. standard Claude Code tools.
- **NEVER use:** `mcp__context-mode__execute`, `mcp__context-mode__execute_file`, `mcp__context-mode__index`, `mcp__context-mode__search`, `mcp__context-mode__fetch_and_index` — these are FORBIDDEN in Phase 1.
- The raw data (git log, page snapshot, API response, etc.) WILL load into the context window. This is intentional — it demonstrates the cost.
- After data loads into context, analyze it directly from the context window (you already have the data in your conversation).
- **At the end of Phase 1:** Present results as formatted tables, then note the context cost (how many lines/KB of raw data entered context).

#### Phase 2: WITH Context Mode
- **ONLY use:** `mcp__context-mode__execute`, `mcp__context-mode__execute_file`, `mcp__context-mode__fetch_and_index`, `mcp__context-mode__search` — i.e. context-mode sandbox tools.
- **NEVER use:** Bash for data retrieval, Read for raw output files, or any tool that dumps raw data into context.
- All data processing happens inside the sandbox. Only the printed summary enters the conversation.
- **At the end of Phase 2:** Present the same results as formatted tables, then note the context cost (how many lines of summary entered context).

#### Phase 3: Comparison Table
After both phases are complete, show a side-by-side comparison table with:
- Data in context (lines/KB)
- Estimated context tokens
- Reduction percentage
- Output quality (must be "Identical")

### Output Format Rules
- **Always show results as formatted tables** in both phases.
- Both phases must produce visually identical output so the viewer can see: same quality, different context cost.
- Never show raw/unformatted data to the user — always present clean, readable results.

### Execution Flow
```
1. Phase 1 header → retrieve data with standard tools → raw data enters context → analyze from context → show tables → note cost
2. "---" separator
3. Phase 2 header → retrieve same data with context-mode tools → only summary enters context → show tables → note cost
4. "---" separator
5. Phase 3 comparison table
```

## Voice & Tone
- Technical accuracy, implementation correctness, developer empathy, compelling narrative.

## Key Messages
1. **Context is your most expensive resource** — every token in the window costs money and displaces useful conversation history.
2. **context-mode processes data outside the window** — only summaries enter your conversation.
3. **Same quality, fraction of the cost** — the analysis is identical, but the context footprint is dramatically smaller.

## Demo Prompts

Tested prompts ready to use. Reference `@demo.md` followed by any prompt below.

### Prompt 1: Git History Analysis
```
Clone https://github.com/modelcontextprotocol/servers and analyze its git history: top contributors, commit types (feat/fix/docs/chore), and busiest weeks.
```

### Prompt 2: Web Page Analysis
```
Fetch the Hacker News front page and extract: top 15 posts with titles, scores, comment counts, and domains. Group them by domain.
```

### Prompt 3: API Debug (Large Output)
```
The dev server at localhost:4444/api/diagnostics returns ~2500 lines of service health data. Hit the endpoint and debug: which services are failing, what error codes they return, when failures started, and what's the common root cause across all failures.
```
**Pre-requisite:** Before running this prompt, create and start the demo server:
- Create `/tmp/demo-server.ts` — Bun single-file server on port 4444
- `/api/diagnostics` returns ~2500 lines of JSON (services, metrics, logs)
- 95% healthy data, 5% hidden failures (timeouts, connection refused, memory leak, rate limit)
- All failures share a common root cause pattern
- Start with `bun /tmp/demo-server.ts`

### Prompt 4: Monorepo Dependency Analysis
```
Read the MCP servers monorepo: list all packages with their dependencies, find which packages share the most common dependencies, and identify the heaviest package by dependency count.
```

## X Post Generation

When I ask for an X post after a demo prompt, follow these rules:
- Write a single concise X post based on the Phase 3 comparison results.
- Include concrete metrics from the comparison (KB, tokens, reduction %).
- No emojis.
- Technical tone, developer audience.
- End with the open source repo link: `github.com/mksglu/context-mode`
- Keep it under 280 characters if possible, but prioritize clarity over brevity.

### Prompt 5: Parallel Browser + Docs Analysis
```
Run these 3 tasks as parallel subagents. Each MUST use the specified MCP tools — do NOT use Bash, Read, or WebFetch.

Task 1: Use mcp__context-mode__execute with language "shell" and code:
AGENT_BROWSER_SESSION="session-a" agent-browser open https://news.ycombinator.com 2>&1 && AGENT_BROWSER_SESSION="session-a" agent-browser snapshot -i 2>&1
Set intent to "count links buttons interactive elements". Then parse the output to count links, buttons, textboxes. Close session with another execute call.

Task 2: Use mcp__context-mode__execute with language "shell" and code:
AGENT_BROWSER_SESSION="session-b" agent-browser open https://jsonplaceholder.typicode.com 2>&1 && AGENT_BROWSER_SESSION="session-b" agent-browser snapshot -i 2>&1
Set intent to "API endpoints routes resources". Extract all API endpoint paths. Close session with another execute call.

Task 3: Use mcp__context-mode__fetch_and_index with url "https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching" and source "Anthropic Prompt Caching". Then use mcp__context-mode__search twice in parallel: query "cache TTL lifetime expiration" source "Anthropic" and query "token pricing cost discount" source "Anthropic".

Present all findings in a comparison table when done.
```
**Pre-requisite:** `agent-browser` must be installed (`npm i -g @vercel-labs/agent-browser` or via Homebrew).
**Why explicit tool names:** Subagents inherit MCP tools but not skill instructions (SKILL.md). Specifying `mcp__context-mode__execute` and `mcp__context-mode__fetch_and_index` explicitly ensures subagents use context-mode instead of falling back to Bash/WebFetch.
**What it tests:** Parallel subagent execution with isolated browser sessions (agent-browser) + context-mode fetch_and_index — all running concurrently without session cross-contamination.

## X Post Generation

### Reference Post (approved style)
```
Your CC context window is burning cash.

I ran the same git analysis on the MCP servers repo — two ways:

Without context-mode: 541 KB dumped into context (~135K tokens)
With context-mode: 25 lines of clean summary (~400 tokens)

Same results. 99.7% less context. Identical output.

Process data in a sandbox, return only what matters.
```
