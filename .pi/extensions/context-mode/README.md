# context-mode extension for pi coding agent

A pi extension that provides context management tools to keep raw tool output in the sandbox instead of flooding the context window.

## Features

- **Session event capture** — Automatically captures tool calls, file operations, git commands, and user decisions
- **Resume snapshots** — Builds XML snapshots on compaction to preserve session context
- **MCP-compatible tools** — Provides tools that mirror the MCP server functionality

## Installation

1. Copy this directory to `~/.pi/agent/extensions/context-mode/` or use it project-local in `.pi/extensions/`
2. Install dependencies:
   ```bash
   cd .pi/extensions/context-mode
   npm install
   ```

## Tools

### batch_execute
Execute multiple shell commands and search queries in a single call.

### execute
Execute code in a sandboxed environment (Python, JavaScript, TypeScript, Bash, etc.).

### execute_file
Execute code from a file in the sandbox.

### search
Search indexed content from batch_execute and fetch_and_index results.

### fetch_and_index
Fetch a web page and index its content for later search.

## Commands

### /ctx-stats
Show context-mode session statistics including event counts and compaction history.

### /ctx-doctor
Run diagnostics to check database path, session ID, and event counts.

## MCP Server (Optional)

For full search and indexing functionality, configure the MCP server in `.mcp.json`:

```json
{
  "mcpServers": {
    "context-mode": {
      "command": "node",
      "args": ["/path/to/context-mode/server.bundle.mjs"]
    }
  }
}
```

## How It Works

1. **Session capture**: The extension hooks into `tool_result` events to capture file operations, git commands, environment changes, and other session events.

2. **Snapshot building**: On compaction (`session_before_compact`), captured events are converted to an XML resume snapshot that summarizes the session state.

3. **Context injection**: On the next prompt after compaction, the snapshot is injected into the system prompt to restore session awareness.

4. **Priority tiers**: Events are organized by priority:
   - P1: Files, tasks, rules (most important)
   - P2: CWD, errors, decisions, environment, git
   - P3-P4: Subagents, skills, roles, data, intent (less critical)

## Event Categories

| Category | Description | Priority |
|----------|-------------|----------|
| file | File read/write/edit operations | 1 |
| task | Todo/task management | 1 |
| rule | CLAUDE.md, SKILL.md, .pi/ reads | 1 |
| cwd | Working directory changes | 2 |
| error | Tool errors and failures | 2 |
| decision | User decisions and corrections | 2 |
| env | Environment setup (npm, pip, etc.) | 2 |
| git | Git operations | 2 |
| subagent | Subagent launches and completions | 2-3 |
| mcp | MCP tool calls | 3 |
| intent | Session mode classification | 4 |
| role | Persona/behavioral directives | 3 |
| data | Large user-pasted data | 4 |
