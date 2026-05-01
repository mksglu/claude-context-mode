# context-mode — MANDATORY routing rules

## Rules

- For data-heavy operations, use context-mode MCP tools instead of `run_command`/`view_file`.
- Prefer the BrowserOS context-mode toolchain for execution, batch execution, indexing, search, and fetch-and-index workflows.
- Use these tools when working with large codebases, indexed content, or workflows that benefit from search and retrieval.

## Available Tools

| Tool | Description |
|------|-------------|
| `ctx_execute` | Sandbox code execution |
| `ctx_batch_execute` | Batch command execution |
| `ctx_index` | Content indexing |
| `ctx_search` | FTS5 search |
| `ctx_doctor` | Health check |
| `ctx_stats` | Statistics |
| `ctx_fetch_and_index` | Web fetch + indexing |