# Context-Mode Installation Guide

## Overview
Context-mode is an MCP (Model Context Protocol) server that optimizes context window usage for AI coding agents by keeping raw data in a sandbox environment. This reduces context consumption by up to 98%.

## Quick Install

### For Claude Code (CLI)
```bash
# Via plugin marketplace (recommended)
/plugin marketplace add mksglu/context-mode
/plugin install context-mode@context-mode

# Verify installation
/context-mode:ctx-doctor
```

Alternative MCP-only install (no hooks):
```bash
claude mcp add context-mode -- npx -y context-mode
```

### For Cursor IDE
1. Install globally:
   ```bash
   npm install -g context-mode
   ```

2. Create `.cursor/mcp.json`:
   ```json
   {
     "mcpServers": {
       "context-mode": {
         "command": "context-mode"
       }
     }
   }
   ```

3. Create `.cursor/hooks.json`:
   ```json
   {
     "version": "1.0",
     "hooks": {
       "preToolUse": [
         { "matcher": "*", "command": "context-mode hook cursor pretooluse" }
       ],
       "postToolUse": [
         { "matcher": "*", "command": "context-mode hook cursor posttooluse" }
       ],
       "stop": [
         { "command": "context-mode hook cursor stop" }
       ]
     }
   }
   ```

4. Copy routing rules:
   ```bash
   cp node_modules/context-mode/configs/cursor/context-mode.mdc .cursor/rules/context-mode.mdc
   ```

5. Restart Cursor

### For VS Code Copilot
1. Install globally:
   ```bash
   npm install -g context-mode
   ```

2. Create `.vscode/mcp.json`:
   ```json
   {
     "servers": {
       "context-mode": {
         "command": "context-mode"
       }
     }
   }
   ```

3. Create `.github/hooks/context-mode.json`:
   ```json
   {
     "version": "1.0",
     "hooks": {
       "sessionStart": [
         { "type": "command", "command": "context-mode hook vscode-copilot sessionstart" }
       ]
     }
   }
   ```

4. Restart VS Code

### For Gemini CLI
1. Install globally:
   ```bash
   npm install -g context-mode
   ```

2. Add to `~/.gemini/settings.json`:
   ```json
   {
     "mcp": {
       "servers": {
         "context-mode": {
           "command": "context-mode"
         }
       }
     },
     "hooks": {
       "BeforeTool": "context-mode hook gemini-cli beforetool",
       "AfterTool": "context-mode hook gemini-cli aftertool",
       "PreCompress": "context-mode hook gemini-cli precompress",
       "SessionStart": "context-mode hook gemini-cli sessionstart"
     }
   }
   ```

3. Restart Gemini CLI

## Prerequisites
- **Node.js 18+** (required for most platforms)
- **Node.js 22.13+** (recommended - uses built-in `node:sqlite` instead of native addons)
- **Bun** (optional - can be used as an alternative runtime)

## Verification
After installation, verify context-mode is working:

```bash
# In chat, type:
ctx stats
ctx doctor
```

The `ctx doctor` command should show all checks passing with `[x]` marks.

## Available Tools
Once installed, you'll have access to these MCP tools:

- **ctx_batch_execute** - Run multiple commands, auto-index output, search in one call
- **ctx_execute** - Execute code in sandbox without flooding context
- **ctx_execute_file** - Process files in sandbox, return only summaries
- **ctx_search** - Search previously indexed content
- **ctx_index** - Index documentation into searchable knowledge base
- **ctx_fetch_and_index** - Fetch URLs, convert HTML to markdown, index and preview

## Utility Commands
- `ctx stats` - View context consumption statistics
- `ctx doctor` - Diagnose installation issues
- `ctx upgrade` - Upgrade to latest version
- `ctx insight` - Open analytics dashboard
- `ctx purge` - Delete all indexed content

## Platform Compatibility

| Platform | MCP Server | PreToolUse Hook | PostToolUse Hook | SessionStart Hook |
|----------|:----------:|:--------------:|:---------------:|:----------------:|
| Claude Code | ✓ | ✓ | ✓ | ✓ |
| Cursor | ✓ | ✓ | ✓ | - |
| VS Code Copilot | ✓ | ✓ | ✓ | ✓ |
| Gemini CLI | ✓ | ✓ | ✓ | ✓ |
| OpenCode | ✓ | Plugin | Plugin | - |
| Codex CLI | ✓ | ✓ | ✓ | - |
| Kiro | ✓ | ✓ | ✓ | - |

## Security
Context-mode respects your existing permission rules and extends them to the MCP sandbox. Add rules to `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": [
      "Bash(sudo *)",
      "Bash(rm -rf /*)",
      "Read(.env)",
      "Read(**/.env*)"
    ],
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)"
    ]
  }
}
```

## Troubleshooting

### Build Prerequisites (CentOS, RHEL, Alpine)
If you're on an older glibc system, you may need to install build tools:

**CentOS 8 / RHEL 8:**
```bash
dnf install -y gcc-toolset-10-gcc gcc-toolset-10-gcc-c++ make python3 python3-setuptools
scl enable gcc-toolset-10 'npm install -g context-mode'
```

**Alpine Linux:**
```bash
apk add --no-cache python3 make g++ sqlite-dev
npm install -g context-mode
```

## More Information
- GitHub: https://github.com/mksglu/context-mode
- Full Documentation: See README.md in the repository
- Platform-specific configs: `configs/` directory
