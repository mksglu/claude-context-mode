# scripts/

PowerShell scripts for building, deploying, and configuring context-mode on Windows.

## Quick start

```powershell
.\scripts\build.ps1
.\scripts\deploy.ps1
.\scripts\setup-tools.ps1
```

---

## build.ps1

Compiles TypeScript and bundles all artifacts.

```powershell
.\scripts\build.ps1
```

**Requires:** Node.js 18+, npm

**Produces:**
- `server.bundle.mjs` — MCP server
- `cli.bundle.mjs` — CLI binary
- `hooks/session-*.bundle.mjs` — hook scripts

---

## deploy.ps1

Installs context-mode globally from the local build so the `context-mode`
command is available system-wide.

```powershell
.\scripts\deploy.ps1
```

Run `build.ps1` first. If `context-mode` is not found after install, check
that npm's global bin directory is in your PATH:

```powershell
npm config get prefix   # bin is at <prefix>/
```

---

## setup-tools.ps1

Writes MCP server registration and hook configs for your coding tools.
Existing JSON files are merged — other settings are preserved.

```powershell
# Interactive menu
.\scripts\setup-tools.ps1

# One or more specific tools
.\scripts\setup-tools.ps1 -Tool claudecode, cursor

# All tools at once
.\scripts\setup-tools.ps1 -Tool all

# Project-scoped configs in a different directory
.\scripts\setup-tools.ps1 -Tool vscode, cursor -ProjectDir C:\projects\myapp
```

**Supported tools:**

| Name | Config written |
|---|---|
| `claudecode` | Runs `claude mcp add context-mode` |
| `gemini` | `~/.gemini/settings.json` (MCP + hooks) |
| `vscode` | `.vscode/mcp.json`, `.github/hooks/context-mode.json` |
| `cursor` | `.cursor/mcp.json`, `.cursor/hooks.json`, `.cursor/rules/context-mode.mdc` |
| `opencode` | `opencode.json`, `AGENTS.md` |
| `kilo` | `kilo.json` |
| `codex` | `~/.codex/config.toml` |
| `kiro` | `.kiro/mcp.json`, `.kiro/hooks/context-mode.json` |

`vscode`, `cursor`, `opencode`, `kilo`, and `kiro` write project-scoped files
into `-ProjectDir` (defaults to the current directory).

After setup, restart your tool and verify with `ctx doctor`.
