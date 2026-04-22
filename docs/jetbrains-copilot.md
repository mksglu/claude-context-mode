# JetBrains Copilot setup

This guide explains how to use `context-mode` with GitHub Copilot in JetBrains IDEs.

## 1) Install GitHub Copilot in JetBrains

1. Open your JetBrains IDE (`IntelliJ IDEA`, `PyCharm`, etc.).
2. Go to `Settings/Preferences -> Plugins -> Marketplace`.
3. Search for `GitHub Copilot` and install it.
4. Restart the IDE and sign in to GitHub Copilot when prompted.

## 2) Add MCP server config

Create `.idea/mcp.json` in your project root.

Example:

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

## 3) Verify

- Restart the IDE after creating `.idea/mcp.json`.
- Run `context-mode doctor` in the project directory.
- Confirm MCP registration reports `context-mode found in .idea/mcp.json`.

