# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. Antigravity does not expose native pre/post tool hooks yet, so these rules and the `.agent/workflows/context-mode.md` workflow are your primary enforcement layer. Follow them strictly.

## BLOCKED commands — do NOT use these

### curl / wget — FORBIDDEN
Do NOT use `curl` or `wget` in any shell command. They dump raw HTTP responses directly into context.
Instead use:
- `mcp__context-mode__ctx_fetch_and_index(url, source)` to fetch and index web pages
- `mcp__context-mode__ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in the sandbox

### Inline HTTP — FORBIDDEN
Do NOT run inline HTTP calls via `node -e "fetch(..."`, `python -c "requests.get(..."`, or similar patterns. They bypass the sandbox and flood context.
Instead use:
- `mcp__context-mode__ctx_execute(language, code)` to run HTTP calls in the sandbox

### Raw large-output shell commands — FORBIDDEN
Do NOT run shell commands that will dump large logs, test output, diffs, or search results directly into context.
Instead use:
- `mcp__context-mode__ctx_batch_execute(commands, queries)` to gather and search in one step
- `mcp__context-mode__ctx_execute(language: "shell", code: "...")` to summarize inside the sandbox

## Redirected work patterns

### File analysis
If you are reading a file to edit it, reading the file directly is fine.
If you are reading a file to analyze, explore, summarize, or answer questions about it, prefer:
- `mcp__context-mode__ctx_execute_file(path, language, code)` so only your summary enters context

### Repo discovery
For broad repo exploration, prefer:
- `mcp__context-mode__ctx_batch_execute(commands, queries)`
- `mcp__context-mode__ctx_search(queries)`

### Web research
Fetch first, search second:
- `mcp__context-mode__ctx_fetch_and_index(url, source)`
- `mcp__context-mode__ctx_search(queries)`

## Output constraints

- Keep inline responses under 500 words when possible.
- Write artifacts to files and return the path plus a one-line description.
- Use descriptive source labels when indexing content so later searches stay precise.
