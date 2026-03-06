# context-mode Installation

Multi-LLM CLI installer supporting Claude Code, Gemini CLI, OpenCode, Codex, and VS Code Copilot.

## Quick Install

```bash
npx context-mode-install
```

## Supported Runtimes

| Runtime | Flag | Config Directory |
|---------|------|------------------|
| Claude Code | `-c, --claude` | `~/.claude/` |
| Gemini CLI | `-g, --gemini` | `~/.gemini/` |
| OpenCode | `-o, --opencode` | `~/.config/opencode/` |
| Codex | `-x, --codex` | `~/.codex/` |
| VS Code Copilot | `-v, --vscode` | `~/.vscode/copilot/` |

## Install Options

### Single Runtime

```bash
# Claude Code (default)
npx context-mode-install
npx context-mode-install --claude

# Gemini CLI
npx context-mode-install --gemini

# OpenCode
npx context-mode-install --opencode

# Codex
npx context-mode-install --codex

# VS Code Copilot
npx context-mode-install --vscode
```

### Multiple Runtimes

```bash
# Claude Code + Gemini CLI
npx context-mode-install --claude --gemini

# Claude Code + OpenCode + Codex
npx context-mode-install -c -o -x
```

### All Runtimes

```bash
npx context-mode-install --all
```

### Global vs Local

```bash
# Global install (default) - all projects
npx context-mode-install --claude --global

# Local install - current project only
npx context-mode-install --claude --local
```

### Custom Account Directory

```bash
npx context-mode-install --claude --account ~/.custom-account
```

### Combined Options

```bash
# All runtimes, global
npx context-mode-install --all --global

# Specific runtimes, local
npx context-mode-install --gemini --opencode --local

# Custom directory
npx context-mode-install -c -g -A ~/.multi-llm
```

## Command Reference

### Runtime Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--claude` | `-c` | Install to Claude Code |
| `--gemini` | `-g` | Install to Gemini CLI |
| `--opencode` | `-o` | Install to OpenCode |
| `--codex` | `-x` | Install to Codex |
| `--vscode` | `-v` | Install to VS Code Copilot |
| `--all` | `-a` | Install to all runtimes |

### Location Flags

| Flag | Description |
|------|-------------|
| `--global` | Install globally (default) |
| `--local` | Install locally (current project) |
| `--account <path>` | Custom account directory |

### Other Options

| Flag | Short | Description |
|------|-------|-------------|
| `--marketplace <name>` | `-m` | Marketplace to install |
| `--help` | `-h` | Show help |

## GSD Comparison

| Feature | GSD | context-mode |
|---------|-----|--------------|
| Claude Code | ✓ | ✓ |
| Gemini CLI | ✓ | ✓ |
| OpenCode | ✓ | ✓ |
| Codex | ✓ | ✓ |
| VS Code Copilot | - | ✓ |
| `--all` flag | ✓ | ✓ |
| Global/Local | ✓ | ✓ |
| Install-time conversion | ✓ | - |

## Manual Installation

### 1. Clone the repository

```bash
git clone https://github.com/mksglu/context-mode.git \
  ~/.claude/plugins/cache/context-mode/context-mode/1.0.5
```

### 2. Install dependencies

```bash
cd ~/.claude/plugins/cache/context-mode/context-mode/1.0.5
npm install
npm run build
```

### 3. Register the plugin

Edit `~/.claude/plugins/installed_plugins.json`:

```json
{
  "version": 2,
  "plugins": {
    "context-mode@context-mode": [{
      "scope": "user",
      "installPath": "/Users/YOUR_USERNAME/.claude/plugins/cache/context-mode/context-mode/1.0.5",
      "version": "1.0.5",
      "installedAt": "2026-03-06T00:00:00.000Z"
    }]
  }
}
```

### 4. Enable in settings

Edit `~/.claude/.claude.json`:

```json
{
  "enabledPlugins": {
    "context-mode@context-mode": true
  }
}
```

## Verification

After installation:

```bash
# Check plugin registry
cat ~/.claude/plugins/installed_plugins.json

# Check enabled plugins
grep -A2 'enabledPlugins' ~/.claude/.claude.json
```

Restart your CLI to activate the plugin.

## Uninstall

```bash
rm -rf ~/.claude/plugins/cache/context-mode
rm -rf ~/.claude/plugins/marketplaces/context-mode
```

Edit `~/.claude/plugins/installed_plugins.json` and `~/.claude/.claude.json` to remove context-mode entries.

## Troubleshooting

**Plugin not showing up:**
1. Restart the CLI completely
2. Check that `installed_plugins.json` paths are correct
3. Verify `enabledPlugins` in the settings file

**Build failures:**
1. Ensure Node.js and npm are installed
2. Run `npm install` and `npm run build` manually in the plugin directory

**Permission errors:**
1. Try with `sudo` for global installs
2. Or use `--local` for project-level installation

## Related Issues

- https://github.com/anthropics/claude-code/issues/9719
- https://github.com/anthropics/claude-code/issues/14485

## References

- GSD Multi-LLM: https://github.com/gsd-build/get-shit-done
- GSD NPM: https://www.npmjs.com/package/get-shit-done-cc
