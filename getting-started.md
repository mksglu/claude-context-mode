# Getting Started with context-mode

context-mode is an MCP server that keeps raw tool output out of your context window. Instead of flooding the conversation with file contents, command output, or web pages, it runs everything in an isolated sandbox and returns only what matters — typically a 10-100x reduction in context consumption.

---

## How it works

Every tool call that would normally dump raw data into context is intercepted and redirected:

- **Commands** run in a sandboxed subprocess. Only stdout enters context.
- **Files** are processed in-sandbox via code you write. Raw content never appears.
- **Web pages** are fetched, converted to markdown, and chunked into a searchable knowledge base. The raw HTML never enters context.
- **Search results** are retrieved on demand from that knowledge base using BM25 + trigram ranking.

The result: a session that stays coherent through hundreds of tool calls instead of compacting after a dozen.

---

## Build from source

**Prerequisites:** Node.js 18+, npm

```powershell
.\scripts\build.ps1
```

This runs `npm install` and `npm run build`, producing:

| File | Purpose |
|---|---|
| `server.bundle.mjs` | MCP server |
| `cli.bundle.mjs` | CLI binary |
| `hooks/session-*.bundle.mjs` | Session continuity hooks |

---

## Deploy globally

```powershell
.\scripts\deploy.ps1
```

Runs `npm install -g .` and confirms the `context-mode` binary is reachable. Run `build.ps1` first.

If `context-mode` is not found after install, check that npm's global bin is in your PATH:

```powershell
npm config get prefix   # bin lives at <prefix>/
```

---

## Configure your tools

```powershell
# Interactive menu
.\scripts\setup-tools.ps1

# Specific tools
.\scripts\setup-tools.ps1 -Tool claudecode, cursor

# All tools, configs written into a project directory
.\scripts\setup-tools.ps1 -Tool all -ProjectDir C:\projects\myapp
```

### What gets written

| Tool | Files written |
|---|---|
| **Claude Code** | Runs `claude mcp add`; writes `claude_desktop_config.json` |
| **Gemini CLI** | `~/.gemini/settings.json` (MCP server + hooks) |
| **VS Code Copilot** | `.vscode/mcp.json`, `.github/hooks/context-mode.json` |
| **Cursor** | `.cursor/mcp.json`, `.cursor/hooks.json`, `.cursor/rules/context-mode.mdc` |
| **OpenCode** | `opencode.json`, `AGENTS.md` |
| **KiloCode** | `kilo.json` |
| **Codex CLI** | `~/.codex/config.toml` |
| **Kiro** | `.kiro/mcp.json`, `.kiro/hooks/context-mode.json` |

All configs use an **absolute path** to `node` + `cli.bundle.mjs` — no PATH dependency.

Existing JSON files are merged. Your other settings are preserved.

### Verify

After restarting your tool:

```
ctx doctor
```

All checks should show `[x]`. Doctor validates runtimes, hooks, FTS5, and server connectivity.

---

## MCP tools reference

### Sandbox execution

#### `ctx_execute`
Run code in an isolated subprocess. Supports 11 languages. Only stdout enters context.

```
ctx_execute(language: "javascript", code: "console.log(42)")
```

Languages: `javascript`, `typescript`, `python`, `shell`, `ruby`, `go`, `rust`, `php`, `perl`, `r`, `elixir`

Typical saving: **56 KB → 299 B**

#### `ctx_execute_file`
Run code against a file. The file's raw content never enters context — only your script's output does.

```
ctx_execute_file(path: "src/server.ts", language: "javascript", code: `
  const lines = FILE_CONTENT.split('\n');
  console.log('Lines:', lines.length);
  console.log('Exports:', lines.filter(l => l.startsWith('export')).length);
`)
```

The file content is pre-loaded into `FILE_CONTENT` and `FILE_CONTENT_PATH`. Typical saving: **45 KB → 155 B**

#### `ctx_batch_execute`
Run multiple shell commands and search queries in a single call. The primary tool for codebase research.

```
ctx_batch_execute(
  commands: ["git log --oneline -20", "npm test 2>&1"],
  queries: ["authentication flow", "error handling"]
)
```

Typical saving: **986 KB → 62 KB**

---

### Knowledge base

#### `ctx_fetch_and_index`
Fetch a URL, convert to markdown, chunk and index into the knowledge base. 24-hour TTL cache — repeated calls skip the network.

```
ctx_fetch_and_index(url: "https://docs.example.com/api", source: "Example API docs")
```

Use `force: true` to bypass the cache. Typical saving: **60 KB → 40 B**

#### `ctx_index`
Index any markdown content directly (not from a URL).

```
ctx_index(content: markdownString, source: "My notes")
```

#### `ctx_search`
Query the knowledge base. Accepts multiple queries in one call, merges results with Reciprocal Rank Fusion.

```
ctx_search(queries: ["authentication", "JWT tokens"], source: "Example API docs")
```

Use `contentType: "code"` or `contentType: "prose"` to filter. Results include smart snippets — extracted windows around matching terms, not truncated pages.

---

### Session management

#### `ctx_stats`
Show context savings for the current session — bytes consumed, savings ratio, cache hits, call counts.

#### `ctx_doctor`
Diagnose the installation. Checks runtimes, hooks, FTS5, server connectivity, and version.

#### `ctx_upgrade`
Upgrade to the latest version, rebuild, and reconfigure hooks.

#### `ctx_purge`
Permanently delete all indexed content from the knowledge base.

---

## Usage patterns

### Analyzing a file
```
# Don't read the file into context — process it in sandbox
ctx_execute_file(path: "src/store.ts", language: "javascript", code: `
  const fns = FILE_CONTENT.match(/^  \w+\(/gm) || [];
  console.log(fns.join('\n'));
`)
```

### Researching the codebase
```
# One call instead of many reads/greps
ctx_batch_execute(
  commands: ["git log --oneline -10", "grep -r 'TODO' src/ --include='*.ts'"],
  queries: ["database schema", "error handling"]
)
```

### Indexing documentation
```
# Fetch once, search many times
ctx_fetch_and_index(url: "https://docs.example.com", source: "API docs")
ctx_search(queries: ["rate limiting", "pagination"], source: "API docs")
```

### Counting, filtering, comparing data
Instead of reading raw data and reasoning about it mentally, write code:
```
ctx_execute(language: "javascript", code: `
  const fs = require('fs');
  const files = fs.readdirSync('src').filter(f => f.endsWith('.ts'));
  console.log(files.length, 'TypeScript files');
  console.log(files.filter(f => f.includes('test')).length, 'test files');
`)
```

---

## Session continuity

When the context window compacts, context-mode rebuilds your working state automatically from a per-project SQLite database. The model continues from your last prompt without asking you to repeat context.

This requires hooks to be configured (handled by `setup-tools.ps1`). Check hook status with `ctx_doctor`.

---

## Diagnostics

| Symptom | Fix |
|---|---|
| Tools not appearing | Restart the tool; check `ctx_doctor` |
| `context-mode` not found | Run `deploy.ps1`; verify npm global bin is in PATH |
| JSON parse error in Claude Desktop | Re-run `setup-tools.ps1 -Tool claudecode` (BOM issue) |
| Hooks not firing | Re-run `setup-tools.ps1` for your tool |
| Slow execution | Install Bun for 3-5x faster JS/TS: `npm install -g bun` |
