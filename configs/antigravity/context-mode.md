# context-mode workflow

Use context-mode MCP tools by default for data-heavy operations. Antigravity does not have native tool hooks yet, so this workflow is the working substitute for context-efficient behavior.

## Workflow rules

1. Do not use `curl`, `wget`, inline `fetch(...)`, or raw HTTP helper scripts. Use `mcp__context-mode__ctx_fetch_and_index(...)` or `mcp__context-mode__ctx_execute(...)`.
2. Do not dump large shell output directly into context. Use `mcp__context-mode__ctx_batch_execute(...)` or `mcp__context-mode__ctx_execute(language: "shell", ...)` and summarize inside the sandbox.
3. If you are reading a file to analyze rather than edit, prefer `mcp__context-mode__ctx_execute_file(...)` so only the summary enters context.
4. For broad repo discovery, gather once and search many times:
   - `mcp__context-mode__ctx_batch_execute(commands, queries)`
   - `mcp__context-mode__ctx_search(queries)`
5. For web content, fetch first and search the indexed result second:
   - `mcp__context-mode__ctx_fetch_and_index(url, source)`
   - `mcp__context-mode__ctx_search(queries)`
6. Write large artifacts to files and return only the file path plus a one-line summary.
