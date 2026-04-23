# JetBrains Copilot setup

This guide explains how to use `context-mode` with GitHub Copilot in JetBrains IDEs
(IntelliJ IDEA, PyCharm, WebStorm, GoLand, RubyMine, JetBrains Client, etc.).

## How it works

The GitHub Copilot plugin for JetBrains (ID `com.github.copilot`, plugin
marketplace ID `17718`) bundles the same Copilot agent runtime as the VS Code
extension. That shared agent reads two independent config surfaces:

1. **MCP server config** — **managed via the IDE Settings UI**, not a
   project-scoped file. The plugin persists it internally; you configure it
   once per user.
2. **Hook config** — read from `.github/hooks/*.json` in the current
   workspace. The agent's `loadEventsForWorkspace()` fires at session start and
   iterates every `.json` file in that directory. Same convention as VS Code
   Copilot.

Because the agent is shared, `context-mode`'s hook integration works on
JetBrains the same way it does on VS Code. Only the MCP server registration
step differs.

## Prerequisites

- A supported JetBrains IDE (2024.2+).
- [GitHub Copilot plugin](https://plugins.jetbrains.com/plugin/17718-github-copilot)
  **v1.5.57 or later** (MCP support went GA on 2025-08-13; older builds
  cannot load MCP servers). Check your version at `Settings > Plugins >
  Installed > GitHub Copilot`.
- Node.js 20+ on `PATH` (required to launch the `context-mode` server).

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

Or run it ad-hoc via `npx -y context-mode` (the default used in the example
server entry below).

## 3) Register the MCP server (via IDE Settings UI)

This step lives in the IDE, not a file — JetBrains Copilot persists MCP
configuration internally and does **not** expose the on-disk path.

1. In the IDE, open `Settings` → `Tools` → `GitHub Copilot` → `Model Context
   Protocol (MCP)` → click **Configure** / **Edit** (the button opens an
   `mcp.json` editor).
2. Paste (or merge in):

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

3. Save. The plugin writes this to its internal store — **you do not need to
   commit anything to `.idea/` for MCP registration to work.**
4. Restart the IDE (or "Reload Copilot" if available) so the agent picks up the
   new server.

**Note:** `.idea/mcp.json` is **not** read by JetBrains Copilot. It was a
plausible-looking guess based on VS Code's `.vscode/mcp.json` convention, but
JetBrains Copilot's MCP config is IDE-managed. If you see older docs or
tutorials telling you to create `.idea/mcp.json`, they are incorrect.

## 4) Register the hooks (`.github/hooks/context-mode.json`)

Hooks give context-mode its 98% context-window saving, session persistence,
and dangerous-command guards. The Copilot agent reads any `.json` file under
the workspace's `.github/hooks/` directory at session start, so the fastest
setup is:

```bash
context-mode upgrade
```

Run this from the project root. It detects JetBrains (via
`TERMINAL_EMULATOR=JetBrains-JediTerm` in the built-in terminal) and writes
the correct config to `.github/hooks/context-mode.json`. If detection goes
wrong — e.g. you have `CLAUDE_PROJECT_DIR` stale in your shell — override
explicitly:

```bash
CONTEXT_MODE_PLATFORM=jetbrains-copilot context-mode upgrade
```

### Manual config

If you prefer to write the file by hand, the content is:

```json
{
  "hooks": {
    "PreToolUse": [
      { "type": "command", "command": "context-mode hook jetbrains-copilot pretooluse" }
    ],
    "PostToolUse": [
      { "type": "command", "command": "context-mode hook jetbrains-copilot posttooluse" }
    ],
    "PreCompact": [
      { "type": "command", "command": "context-mode hook jetbrains-copilot precompact" }
    ],
    "SessionStart": [
      { "type": "command", "command": "context-mode hook jetbrains-copilot sessionstart" }
    ]
  }
}
```

The checked-in reference lives at
[`configs/jetbrains-copilot/hooks.json`](../configs/jetbrains-copilot/hooks.json).

## 5) Environment variables

JetBrains IDEs export a small set of env vars that context-mode keys off of.
You don't normally need to set these — the IDE handles it — but they're
useful to know for troubleshooting:

| Variable                 | Purpose                                               |
| ------------------------ | ----------------------------------------------------- |
| `IDEA_INITIAL_DIRECTORY` | Project root (set by Copilot plugin subprocess)       |
| `IDEA_HOME`              | IDE install path                                      |
| `JETBRAINS_CLIENT_ID`    | JetBrains Client session ID                           |
| `TERMINAL_EMULATOR`      | Set to `JetBrains-JediTerm` inside the IDE's built-in terminal; lets `context-mode upgrade` detect JetBrains from the CLI even when `IDEA_*` vars aren't exported to the shell |
| `CLAUDE_PROJECT_DIR`     | Fallback project root (for mixed-tool setups)         |

> **Note on `context-mode upgrade` from the IDE terminal.** JetBrains IDEs
> don't export `IDEA_INITIAL_DIRECTORY` / `JETBRAINS_CLIENT_ID` to the
> built-in terminal — those vars only appear inside the Copilot plugin's
> subprocess. Detection therefore also looks at
> `TERMINAL_EMULATOR=JetBrains-JediTerm`, which *is* reliably exported. If
> you have `CLAUDE_PROJECT_DIR` stale in your shell profile, this signal
> still wins and `upgrade` writes the JetBrains config. To force a specific
> platform, prefix the command:
> `CONTEXT_MODE_PLATFORM=jetbrains-copilot context-mode upgrade`.

## 6) Session persistence

Session events (reads, writes, commands, git ops, etc.) are captured in a
SQLite DB at:

```
~/.config/JetBrains/context-mode/sessions/<projectHash>.db
```

On `PreCompact` the hook builds a <2 KB XML resume snapshot; on
`SessionStart` (source = `compact` or `resume`) that snapshot is injected
back into the conversation so Copilot doesn't lose state after a context
reset.

## 7) Verify

1. Restart the IDE after steps 3 and 4.
2. Open Copilot Chat → switch to agent mode.
3. Prompt: `What MCP tools do you have available?`
   - Expected: six `ctx_*` tools (listed with a `context-mode_` prefix).
4. From the project terminal:

   ```bash
   context-mode doctor
   ```

   Expected checks:
   - `PreToolUse hook: PASS — configured in .github/hooks/context-mode.json`
   - `SessionStart hook: PASS`
   - `MCP registration: WARN — "JetBrains stores MCP config via Settings UI —
     not CLI-inspectable"` (this is normal; verify in the IDE Settings UI).

## Troubleshooting

- **No MCP tools listed in agent mode.** Plugin below v1.5.57 → upgrade the
  GitHub Copilot plugin. Or the server entry isn't saved — re-open the MCP
  configuration panel in Settings and confirm `context-mode` is there.
- **Hooks not firing.** Check `.github/hooks/context-mode.json` exists in the
  workspace root (NOT in a subproject directory). Restart the IDE after
  creating the file.
- **Session state not persisting.** Ensure `IDEA_INITIAL_DIRECTORY` is set
  in the IDE's environment (it is by default when launched via the Toolbox
  App). Different values produce different `projectHash` → different DB
  file. Inspect `~/.config/JetBrains/context-mode/posttooluse-debug.log` for
  hook-level errors.
- **`context-mode upgrade` wrote to the wrong path.** If the shell has
  `CLAUDE_*` env vars from a Claude Code profile, detection may still go
  wrong — force with `CONTEXT_MODE_PLATFORM=jetbrains-copilot context-mode
  upgrade`.

## How this differs from VS Code Copilot

| Aspect                    | VS Code Copilot                           | JetBrains Copilot                                          |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| Shared Copilot agent      | Same runtime                              | Same runtime                                               |
| Hook config path          | `.github/hooks/context-mode.json`         | `.github/hooks/context-mode.json` (**identical**)          |
| MCP server config path    | `.vscode/mcp.json` (project-scoped file)  | IDE Settings UI (user-scoped, not a project file)          |
| Session DB location       | `~/.vscode/context-mode/sessions/`        | `~/.config/JetBrains/context-mode/sessions/`               |
| Session ID source         | `VSCODE_PID` → `vscode-<pid>`             | `JETBRAINS_CLIENT_ID` → `jetbrains-<id>`                   |
| Terminal detection signal | `VSCODE_PID` / `VSCODE_CWD`               | `TERMINAL_EMULATOR=JetBrains-JediTerm` (plus `IDEA_*`)     |

The hook integration is **byte-for-byte identical** — same `.github/hooks/`
path, same JSON schema, same PascalCase hook names, same `hookSpecificOutput`
response shape. Only the MCP registration UX and session storage paths differ
by platform convention.
