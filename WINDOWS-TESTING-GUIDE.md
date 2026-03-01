# Windows Testing Guide — context-mode (dev branch)

> Test the cross-platform branch before it's published to npm/marketplace.

## Prerequisites

- **Windows 10/11**
- **Node.js 18+** — [nodejs.org](https://nodejs.org/)
- **Git** — [git-scm.com](https://git-scm.com/) (includes Git Bash)
- **Claude Code CLI** — installed and authenticated

Optional runtimes (for full language support):
- Python 3.x — [python.org](https://www.python.org/)
- Go — [go.dev](https://go.dev/)
- Elixir — `choco install elixir` via [Chocolatey](https://chocolatey.org/)

## Step 1 — Clone and build

```powershell
git clone https://github.com/mksglu/claude-context-mode.git
cd claude-context-mode
git checkout feat/cross-platform-ci
npm install
npx tsc
```

## Step 2 — Register as MCP server

Add the plugin to your Claude Code MCP config. Run this in PowerShell:

```powershell
$pluginPath = (Resolve-Path .).Path -replace '\\', '/'
claude mcp add context-mode -- node "$pluginPath/start.mjs"
```

This registers the MCP server in `~/.claude/.mcp.json`. You can verify:

```powershell
cat ~/.claude/.mcp.json
```

You should see:
```json
{
  "mcpServers": {
    "context-mode": {
      "command": "node",
      "args": ["C:/Users/you/claude-context-mode/start.mjs"]
    }
  }
}
```

## Step 3 — Install hooks (manual)

The hooks redirect data-fetching tools (curl, WebFetch, etc.) through the context-mode sandbox. On Windows, the hook script requires **Git Bash** (installed with Git).

Edit `~/.claude/settings.json` (create if it doesn't exist):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Read|Grep|Glob|WebFetch|WebSearch|Task",
        "hooks": [
          {
            "type": "command",
            "command": "bash C:/Users/YOU/claude-context-mode/hooks/pretooluse.sh"
          }
        ]
      }
    ]
  }
}
```

> **Important**: Replace `C:/Users/YOU/claude-context-mode` with your actual clone path. Use forward slashes.

## Step 4 — Run doctor

```powershell
npx tsx src/cli.ts doctor
```

Expected output:
```
context-mode doctor
==================

Runtimes
  ✓ javascript  — Node.js v20.x.x (or Bun)
  ✓ typescript   — via tsx
  ✓ python       — Python 3.x.x
  ✓ go           — go1.x.x
  ...

Server
  ✓ Execute JS code — 2+2 = 4

FTS5
  ✓ better-sqlite3 loaded
  ✓ FTS5 virtual tables work

Hooks
  ✓ PreToolUse hook configured
  ✓ Hook script exists
```

If a runtime shows `✗`, that language won't be available but the plugin still works for other languages.

**Critical checks** (must pass): Server, FTS5, and at least 2 runtimes.

## Step 5 — Test in Claude Code

Open any project directory and start Claude Code:

```powershell
cd your-project
claude
```

Try these commands to verify the plugin works:

```
# Execute code in sandbox (output stays out of context)
Use mcp__context-mode__execute to run: console.log("Hello from Windows!")

# Index and search
Use mcp__context-mode__batch_execute to run "dir" and search for file names

# Fetch a URL into knowledge base
Use mcp__context-mode__fetch_and_index to fetch https://example.com
```

## Step 6 — Run the test suite (optional)

```powershell
npx tsx tests/executor.test.ts
npx tsx tests/store.test.ts
npx tsx tests/fuzzy-search.test.ts
npx tsx tests/stream-cap.test.ts
npx tsx tests/search-wiring.test.ts
npx tsx tests/search-fallback-integration.test.ts
npx tsx tests/subagent-budget.test.ts
```

All tests should pass on Windows.

## Troubleshooting

### "better-sqlite3" build fails
```powershell
npm install --build-from-source better-sqlite3
```
If that fails, install Windows build tools:
```powershell
npm install -g windows-build-tools
```

### Hook script not found
Make sure the path in `settings.json` uses **forward slashes** and points to the actual `pretooluse.sh` file. Git Bash must be in your PATH (it is by default with Git for Windows).

### "command not found: bash"
The hook requires `bash` from Git for Windows. Verify:
```powershell
where bash
# Should show: C:\Program Files\Git\bin\bash.exe
```

### Timeout tests hang
If tests seem stuck, check that `taskkill` is available (it's a built-in Windows command). The plugin uses `taskkill /F /T /PID` to kill process trees on Windows.

### Cache / DB location
Session databases are stored in your temp directory:
```
%TEMP%\context-mode-<PID>.db
```
These are ephemeral and auto-cleaned when the session ends.

## Cleanup

To remove the plugin registration:

```powershell
claude mcp remove context-mode
```

To remove hooks, delete the `PreToolUse` entry from `~/.claude/settings.json`.

## Feedback

Report issues on the PR: [feat/cross-platform-ci](https://github.com/mksglu/claude-context-mode/pull/new/feat/cross-platform-ci)

Include:
- Windows version (`winver`)
- Node.js version (`node -v`)
- Doctor output (`npx tsx src/cli.ts doctor`)
- Error message / screenshot
