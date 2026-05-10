# context-mode — MANDATORY routing rules

context-mode MCP tools available. Rules protect context window from flooding. One unrouted command dumps 56 KB into context. Zed has NO hooks — these instructions are ONLY enforcement. Follow strictly.

## Think in Code — MANDATORY

Analyze/count/filter/compare/search/parse/transform data: **write code** via `mcp:context-mode:ctx_execute(language, code)`, `console.log()` only the answer. Do NOT read raw data into context. PROGRAM the analysis, not COMPUTE it. Pure JavaScript — Node.js built-ins only (`fs`, `path`, `child_process`). `try/catch`, handle `null`/`undefined`. One script replaces ten tool calls.

## BLOCKED — do NOT use

### curl / wget — FORBIDDEN
Do NOT use `curl`/`wget` in shell. Dumps raw HTTP into context.
Use: `mcp:context-mode:ctx_fetch_and_index(url, source)` or `mcp:context-mode:ctx_execute(language: "javascript", code: "const r = await fetch(...)")`

### Inline HTTP — FORBIDDEN
No `node -e "fetch(..."`, `python -c "requests.get(..."`. Bypasses sandbox.
Use: `mcp:context-mode:ctx_execute(language, code)` — only stdout enters context

### Direct web fetching — FORBIDDEN
Raw HTML can exceed 100 KB.
Use: `mcp:context-mode:ctx_fetch_and_index(url, source)` then `mcp:context-mode:ctx_search(queries)`

## REDIRECTED — use sandbox

### Shell (>20 lines output)
Shell ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`.
Otherwise: `mcp:context-mode:ctx_batch_execute(commands, queries)` or `mcp:context-mode:ctx_execute(language: "shell", code: "...")`

### File reading (for analysis)
Reading to **edit** → reading correct. Reading to **analyze/explore/summarize** → `mcp:context-mode:ctx_execute_file(path, language, code)`.

### grep / search (large results)
Use `mcp:context-mode:ctx_execute(language: "shell", code: "grep ...")` in sandbox.

## Tool selection

1. **GATHER**: `mcp:context-mode:ctx_batch_execute(commands, queries)` — runs all commands, auto-indexes, returns search. ONE call replaces 30+. Each command: `{label: "header", command: "..."}`.
2. **FOLLOW-UP**: `mcp:context-mode:ctx_search(queries: ["q1", "q2", ...])` — all questions as array, ONE call.
3. **PROCESSING**: `mcp:context-mode:ctx_execute(language, code)` | `mcp:context-mode:ctx_execute_file(path, language, code)` — sandbox, only stdout enters context.
4. **WEB**: `mcp:context-mode:ctx_fetch_and_index(url, source)` then `mcp:context-mode:ctx_search(queries)` — raw HTML never enters context.
5. **INDEX**: `mcp:context-mode:ctx_index(content, source)` — store in FTS5 for later search.

## Parallel I/O batches

For multi-URL fetches or multi-API calls, **always** include `concurrency: N` (1-8):

- `mcp:context-mode:ctx_batch_execute(commands: [3+ network commands], concurrency: 5)` — gh, curl, dig, docker inspect, multi-region cloud queries
- `mcp:context-mode:ctx_fetch_and_index(requests: [{url, source}, ...], concurrency: 5)` — multi-URL batch fetch

**Use concurrency 4-8** for I/O-bound work (network calls, API queries). **Keep concurrency 1** for CPU-bound (npm test, build, lint) or commands sharing state (ports, lock files, same-repo writes).

GitHub API rate-limit: cap at 4 for `gh` calls.

## Output

Write artifacts to FILES — never inline. Return: file path + 1-line description.
Descriptive source labels for `search(source: "label")`.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call `stats` MCP tool, display full output verbatim |
| `ctx doctor` | Call `doctor` MCP tool, run returned shell command, display as checklist |
| `ctx upgrade` | Call `upgrade` MCP tool, run returned shell command, display as checklist |
| `ctx purge` | Call `mcp:context-mode:purge` MCP tool with confirm: true. Warns before wiping knowledge base. |

After /clear or /compact: knowledge base and session stats preserved. Use `ctx purge` to start fresh.
