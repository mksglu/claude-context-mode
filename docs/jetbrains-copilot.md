# JetBrains Copilot setup

This guide explains how to use `context-mode` with GitHub Copilot in JetBrains IDEs
(IntelliJ IDEA, PyCharm, WebStorm, GoLand, RubyMine, JetBrains Client, etc.).

## Prerequisites

- A supported JetBrains IDE (2024.2+).
- [GitHub Copilot](https://plugins.jetbrains.com/plugin/17718-github-copilot) plugin
  installed and signed in.
- Node.js 20+ on `PATH` (required to launch the MCP server).

## 1) Install the GitHub Copilot plugin

1. Open your JetBrains IDE.
2. `Settings / Preferences` → `Plugins` → `Marketplace`.
3. Search for **GitHub Copilot** and install.
4. Restart the IDE and sign in to GitHub Copilot when prompted.

## 2) Install context-mode

```bash
npm install -g context-mode
context-mode doctor
```

Or run it ad-hoc via `npx -y context-mode` (the default used in the config below).

## 3) Register the MCP server

Create `.idea/mcp.json` in the project root:

```json
{
  "servers": {
    "context-mode": {
      "command": "npx",
      "args": ["-y", "context-mode"]
    }
  }
}
```

## 4) Register the hooks

Hooks are what give you the 98 % context-window saving, session persistence, and the
dangerous-command guards. JetBrains needs four entries under `hooks` in `.idea/mcp.json`:

```json
{
  "servers": {
    "context-mode": {
      "command": "npx",
      "args": ["-y", "context-mode"]
    }
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "node \"${PLUGIN_ROOT}/hooks/jetbrains-copilot/pretooluse.mjs\"" }
      ]}
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "node \"${PLUGIN_ROOT}/hooks/jetbrains-copilot/posttooluse.mjs\"" }
      ]}
    ],
    "PreCompact": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "node \"${PLUGIN_ROOT}/hooks/jetbrains-copilot/precompact.mjs\"" }
      ]}
    ],
    "SessionStart": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "node \"${PLUGIN_ROOT}/hooks/jetbrains-copilot/sessionstart.mjs\"" }
      ]}
    ]
  }
}
```

The easier path: **run `context-mode upgrade` from the project root** — it detects the
JetBrains adapter and writes the `hooks` block for you, replacing `${PLUGIN_ROOT}` with
the actual install path.

## 5) Environment variables

JetBrains IDEs export a small set of env vars that context-mode keys off of. You don't
normally need to set these — the IDE handles it — but they're useful to know for
troubleshooting:

| Variable                | Purpose                                               |
| ----------------------- | ----------------------------------------------------- |
| `IDEA_INITIAL_DIRECTORY`| Project root; used as `projectDir` by hooks & adapter |
| `IDEA_HOME`             | IDE install path; signals JetBrains detection         |
| `JETBRAINS_CLIENT_ID`   | JetBrains Client session ID (stable across restarts)  |
| `TERMINAL_EMULATOR`     | Set to `JetBrains-JediTerm` inside the IDE's built-in terminal; lets `context-mode upgrade` detect JetBrains even when `IDEA_*` vars aren't exported to the shell |
| `CLAUDE_PROJECT_DIR`    | Fallback project root (for mixed-tool setups)         |

> **Note on `context-mode upgrade` from the IDE terminal.** JetBrains IDEs don't
> export `IDEA_INITIAL_DIRECTORY` / `JETBRAINS_CLIENT_ID` to the built-in terminal
> — those vars only appear inside the Copilot plugin's subprocess. Detection
> therefore also looks at `TERMINAL_EMULATOR=JetBrains-JediTerm`, which *is*
> reliably exported. If you have `CLAUDE_PROJECT_DIR` stale in your shell profile,
> this signal still wins and `upgrade` writes the JetBrains config. To force a
> specific platform, prefix the command: `CONTEXT_MODE_PLATFORM=jetbrains-copilot
> context-mode upgrade`.

## 6) Session persistence

Session events (reads, writes, commands, git ops, etc.) are captured in a SQLite DB at:

```
~/.config/JetBrains/context-mode/sessions/<projectHash>.db
```

On `PreCompact` the hook builds a <2 KB XML resume snapshot; on `SessionStart` (source =
`compact` or `resume`) that snapshot is injected back into the conversation so Copilot
doesn't lose state after a context reset.

## 7) Verify

1. Restart the IDE after editing `.idea/mcp.json`.
2. Open a Copilot chat — the server should appear as "context-mode".
3. In a terminal from the project root:

   ```bash
   context-mode doctor
   ```

   Expected passing checks:

   - `PreToolUse hook configured in .idea/mcp.json`
   - `SessionStart hook configured in .idea/mcp.json`
   - `MCP registration: context-mode found in .idea/mcp.json`

## Troubleshooting

- **Hooks not firing.** Run `context-mode doctor`. If it reports missing hook entries,
  run `context-mode upgrade`. If the entries exist but hooks still don't fire, restart
  the IDE and inspect the debug logs under
  `~/.config/JetBrains/context-mode/*-debug.log`.
- **Session state not persisting.** Ensure `IDEA_INITIAL_DIRECTORY` is set in the IDE's
  environment (it is by default when launched via the Toolbox App). Different values
  produce different `projectHash` → different DB file.
- **"Configured" shown as the installed version.** There is no JetBrains plugin registry
  entry for context-mode; it runs as an MCP server referenced from `.idea/mcp.json`.
  "configured" means the server entry is present; "unknown" means it isn't yet.

## Differences from VS Code Copilot

| Aspect              | VS Code Copilot                        | JetBrains Copilot                       |
| ------------------- | -------------------------------------- | --------------------------------------- |
| Hook config file    | `.github/hooks/context-mode.json`      | `.idea/mcp.json`                        |
| Session DB dir      | `~/.vscode/context-mode/sessions/`     | `~/.config/JetBrains/context-mode/sessions/` |
| Rule file (startup) | `.github/copilot-instructions.md`      | `.idea/copilot-instructions.md` (falls back to `.github/...`) |
| Session ID source   | `VSCODE_PID` → prefixed `vscode-<pid>` | `JETBRAINS_CLIENT_ID` → prefixed `jetbrains-<id>` |
| Install detection   | Reads `~/.vscode/extensions/extensions.json` | Reads `.idea/mcp.json` entry          |

Both platforms use the same JSON stdin/stdout hook paradigm and the same shared core
(`hooks/core/*`), so routing rules, dangerous-command guards, and session-event
extraction are identical.
