# Platform Support Matrix

This document provides a comprehensive comparison of all platforms supported by context-mode, including their hook paradigms, capabilities, configuration, and known limitations.

## Overview

context-mode supports twelve platforms across three hook paradigms:

| Paradigm | Platforms |
|----------|-----------|
| **JSON stdin/stdout** | Claude Code, Gemini CLI, VS Code Copilot, JetBrains Copilot, Cursor, Codex CLI, Qwen Code |
| **TS Plugin** | OpenCode, OpenClaw |
| **MCP-only** | Antigravity, Kiro, Zed |

The MCP server layer is 100% portable and needs no adapter. Only the hook layer requires platform-specific adapters.

## Prerequisites

All platforms (except Claude Code plugin install) require a global install:

```bash
npm install -g context-mode
```

This puts the `context-mode` binary in PATH, which is required for:
- **MCP server:** `"command": "context-mode"` (replaces ephemeral `npx -y context-mode`)
- **Hook dispatcher:** `context-mode hook <platform> <event>` (replaces `node ./node_modules/...` paths)
- **Utility commands:** `context-mode doctor`, `context-mode upgrade`
- **Persistent upgrades:** `ctx-upgrade` updates the global binary in-place

---

## Main Comparison Table

| Feature | Claude Code | Gemini CLI | VS Code Copilot | JetBrains Copilot | Cursor | OpenCode | Codex CLI | Antigravity | Kiro |
|---------|-------------|------------|-----------------|-------------------|--------|----------|-----------|-------------|------|
| **Paradigm** | json-stdio | json-stdio | json-stdio | json-stdio | json-stdio | ts-plugin | json-stdio | mcp-only | mcp-only |
| **PreToolUse equivalent** | `PreToolUse` | `BeforeTool` | `PreToolUse` | `PreToolUse` | `preToolUse` | `tool.execute.before` | `PreToolUse` | -- | -- |
| **PostToolUse equivalent** | `PostToolUse` | `AfterTool` | `PostToolUse` | `PostToolUse` | `postToolUse` | `tool.execute.after` | `PostToolUse` | -- | -- |
| **PreCompact equivalent** | `PreCompact` | `PreCompress` | `PreCompact` | `PreCompact` | -- | `experimental.session.compacting` | -- | -- | -- |
| **SessionStart** | `SessionStart` | `SessionStart` | `SessionStart` | `SessionStart` | -- (buggy in Cursor) | -- | `SessionStart` | -- | -- |
| **Stop equivalent** | -- | -- | `Stop` | `Stop` | `stop` | -- | `Stop` | -- | -- |
| **Can modify args** | Yes | Yes | Yes | Yes | Yes | Yes | No | -- | -- |
| **Can modify output** | Yes | Yes | Yes | Yes | No | Yes (caveat) | No | -- | -- |
| **Can inject session context** | Yes | Yes | Yes | Yes | Yes | -- | Yes | -- | -- |
| **Can block tools** | Yes | Yes | Yes | Yes | Yes | Yes (throw) | Yes | -- | -- |
| **Config location** | `~/.claude/settings.json` | `~/.gemini/settings.json` | `.github/hooks/*.json` | `.github/hooks/*.json` | `.cursor/hooks.json` or `~/.cursor/hooks.json` | `opencode.json` | `~/.codex/hooks.json` + `~/.codex/config.toml` | `~/.gemini/antigravity/mcp_config.json` | `~/.kiro/settings/mcp.json` |
| **Session ID field** | `session_id` | `session_id` | `sessionId` (camelCase) | `sessionId` (camelCase) | `conversation_id` | `sessionID` (camelCase) | N/A | N/A | N/A |
| **Project dir env** | `CLAUDE_PROJECT_DIR` | `GEMINI_PROJECT_DIR` | `CLAUDE_PROJECT_DIR` | `CLAUDE_PROJECT_DIR` | stdin `workspace_roots` | `ctx.directory` (plugin init) | N/A | N/A | N/A |
| **MCP tool naming** | `mcp__server__tool` | `mcp__server__tool` | `f1e_` prefix | `f1e_` prefix | `MCP:<tool>` in hook payloads | `mcp__server__tool` | `mcp__server__tool` | `mcp__server__tool` | `mcp__server__tool` |
| **Hook command format** | `context-mode hook claude-code <event>` | `context-mode hook gemini-cli <event>` | `context-mode hook vscode-copilot <event>` | `context-mode hook jetbrains-copilot <event>` | `context-mode hook cursor <event>` | TS plugin (no command) | `context-mode hook codex <event>` | N/A | N/A |
| **Hook registration** | settings.json hooks object | settings.json hooks object | `.github/hooks/*.json` | `.github/hooks/*.json` | `hooks.json` native hook arrays | opencode.json plugin array | `~/.codex/hooks.json` | N/A | N/A |
| **MCP server command** | `context-mode` (or plugin auto) | `context-mode` | `context-mode` | `context-mode` | `context-mode` | `context-mode` | `context-mode` | `context-mode` | `context-mode` |
| **Plugin distribution** | Claude plugin registry | npm global | npm global | npm global | npm global | npm global | npm global | npm global | npm global |
| **Session dir** | `~/.claude/context-mode/sessions/` | `~/.gemini/context-mode/sessions/` | `.github/context-mode/sessions/` or `~/.vscode/context-mode/sessions/` | `.github/context-mode/sessions/` | `~/.cursor/context-mode/sessions/` | `~/.config/opencode/context-mode/sessions/` | `~/.codex/context-mode/sessions/` | `~/.gemini/context-mode/sessions/` | `~/.kiro/context-mode/sessions/` |

### Legend

- Yes = Fully supported
- -- = Not supported
- (caveat) = Supported with known issues

---

## Platform Details

### Claude Code

**Status:** Fully supported (primary platform)

**Hook Paradigm:** JSON stdin/stdout

Claude Code is the primary platform for context-mode. All hooks communicate via JSON on stdin/stdout. The adapter reads raw JSON input, normalizes it into platform-agnostic events, and formats responses back into Claude Code's expected output format.

**Hook Names:**
- `PreToolUse` -- fires before a tool is executed
- `PostToolUse` -- fires after a tool completes
- `PreCompact` -- fires before context compaction
- `SessionStart` -- fires when a session starts, resumes, or compacts
- `UserPromptSubmit` -- fires when user submits a prompt

**Blocking:** `permissionDecision: "deny"` in response JSON

**Arg Modification:** `updatedInput` field at top level of response

**Output Modification:** `updatedMCPToolOutput` for MCP tools, `additionalContext` for appending

**Session ID Extraction Priority:**
1. UUID from `transcript_path` field
2. `session_id` field
3. `CLAUDE_SESSION_ID` environment variable
4. Parent process ID fallback

**Hook Commands:**
```
context-mode hook claude-code pretooluse
context-mode hook claude-code posttooluse
context-mode hook claude-code precompact
context-mode hook claude-code sessionstart
context-mode hook claude-code userpromptsubmit
```

**Known Issues:** None significant.

---

### Gemini CLI

**Status:** Fully supported

**Hook Paradigm:** JSON stdin/stdout

Gemini CLI uses the same JSON stdin/stdout paradigm as Claude Code but with different hook names and response format.

**Hook Names:**
- `BeforeTool` -- equivalent to PreToolUse
- `AfterTool` -- equivalent to PostToolUse
- `PreCompress` -- equivalent to PreCompact (advisory only, async, cannot block)
- `SessionStart` -- fires when a session starts

**Blocking:** `decision: "deny"` in response (NOT `permissionDecision`)

**Arg Modification:** `hookSpecificOutput.tool_input` (merged with original, not `updatedInput`)

**Output Modification:** `decision: "deny"` + `reason` replaces output; `hookSpecificOutput.additionalContext` appends

**Environment Variables:**
- `GEMINI_PROJECT_DIR` -- primary project directory
- `CLAUDE_PROJECT_DIR` -- alias (also works)

**Hook Commands:**
```
context-mode hook gemini-cli beforetool
context-mode hook gemini-cli aftertool
context-mode hook gemini-cli precompress
context-mode hook gemini-cli sessionstart
```

**Known Issues / Caveats:**
- `PreCompress` is advisory only (async, cannot block)
- No `decision: "ask"` support
- Hooks don't fire for subagents yet

---

### OpenCode

**Status:** Partially supported

**Hook Paradigm:** TS Plugin

OpenCode uses a TypeScript plugin paradigm instead of JSON stdin/stdout. Hooks are registered via the `plugin` array in `opencode.json`.

**Hook Names:**
- `tool.execute.before` -- equivalent to PreToolUse
- `tool.execute.after` -- equivalent to PostToolUse
- `experimental.session.compacting` -- equivalent to PreCompact (experimental)

**Blocking:** `throw Error` in `tool.execute.before` handler

**Arg Modification:** `output.args` mutation

**Output Modification:** `output.output` mutation (TUI bug for bash, see issue #13575)

**Session ID:** `input.sessionID` (camelCase, note the uppercase `ID`)

**Project Directory:** Available via `ctx.directory` in plugin init, not via environment variable

**Configuration:**
- `opencode.json` or `.opencode/opencode.json`
- Plugin registered in the `plugin` array with npm package names

**Known Issues / Caveats:**
- SessionStart is broken (issue #14808, no hook issue #5409)
- Output modification has TUI rendering bug for bash tool (issue #13575)
- `experimental.session.compacting` is marked experimental and may change
- No `canInjectSessionContext` capability

---

### Codex CLI

**Status:** Supported (MCP active, hooks stable)

**Hook Paradigm:** JSON stdin/stdout

Codex CLI's Rust backend (codex-rs) includes a full hook system with 5 events, using the same JSON stdin/stdout wire protocol as Claude Code. Hooks are configured via `hooks.json`.

**Hook Names:**
- `PreToolUse` -- fires before a tool is executed
- `PostToolUse` -- fires after a tool completes
- `SessionStart` -- fires when a session starts, resumes, or clears
- `UserPromptSubmit` -- fires when user submits a prompt
- `Stop` -- fires when agent turn ends (can continue with followup)

**Blocking:** `permissionDecision: "deny"` in hookSpecificOutput, or exit code 2
**Arg Modification:** NOT supported (updatedInput returns error)
**Output Modification:** NOT supported (updatedMCPToolOutput returns error)
**Context Injection:** `additionalContext` in hookSpecificOutput (PostToolUse, SessionStart only). PreToolUse does NOT support `additionalContext` — the codex formatter handles this automatically (deny works, context/modify/ask responses are dropped).

**Configuration:**
- Hook config: `~/.codex/hooks.json` (JSON format, same structure as Claude Code)
- MCP config: `~/.codex/config.toml` (TOML format, `[mcp_servers]` section)

**Hook Commands:**
```
context-mode hook codex pretooluse
context-mode hook codex posttooluse
context-mode hook codex sessionstart
context-mode hook codex userpromptsubmit
context-mode hook codex stop
```

**Known Issues / Caveats:**
- PreToolUse `additionalContext` is unsupported — context injection works via PostToolUse and SessionStart instead. The codex formatter handles this automatically (deny works, context is dropped). Source: `codex-rs/hooks/src/engine/output_parser.rs:267`.
- PreToolUse input rewriting still needs upstream `updatedInput` support. Track: [openai/codex#18491](https://github.com/openai/codex/issues/18491).
- `tool_name` is always "Bash" (Codex only has one tool type)
- updatedInput and updatedMCPToolOutput are in the schema but NOT implemented
- Default hook timeout: 600 seconds

---

### Qwen Code

**Status:** Supported (MCP + hooks — identical wire protocol to Claude Code)

**Hook Paradigm:** JSON stdin/stdout (same as Claude Code)

Qwen Code (by Alibaba/Qwen team) uses the exact same hook wire protocol as Claude Code, verified from source (`hookRunner.ts`, `claude-converter.ts`). Hooks are configured inside `~/.qwen/settings.json` under the `hooks` key.

**Hook Names:** `PreToolUse`, `PostToolUse`, `SessionStart`, `PreCompact`, `UserPromptSubmit` (Qwen supports 12 events total, context-mode uses these 5)

**Blocking:** `permissionDecision: "deny"` or exit code 2
**Arg Modification:** `updatedInput` in response
**Output Modification:** `updatedMCPToolOutput` in response
**Context Injection:** `additionalContext` in response

**Configuration:**
- Settings + hooks: `~/.qwen/settings.json`
- MCP: `mcpServers` in settings.json
- Sessions: `~/.qwen/context-mode/sessions/`

**Detection:** MCP clientInfo (`qwen-cli-mcp-client-*` pattern), `QWEN_PROJECT_DIR` env var, or `~/.qwen/` config dir.

**Hook Commands:**
```
context-mode hook qwen-code pretooluse
context-mode hook qwen-code posttooluse
context-mode hook qwen-code sessionstart
context-mode hook qwen-code precompact
context-mode hook qwen-code userpromptsubmit
```

---

### Antigravity

**Status:** MCP-only (no hooks)

**Hook Paradigm:** MCP-only

Google Antigravity is an AI-powered IDE by Google/DeepMind. It shares the `~/.gemini/` directory structure with Gemini CLI but uses a separate config path for MCP servers. Antigravity does not expose a public hook API — only MCP integration is available.

**Configuration:**
- `~/.gemini/antigravity/mcp_config.json` (JSON format)
- MCP servers configured in `mcpServers` object

**Detection:**
- Auto-detected via MCP protocol handshake (`clientInfo.name: "antigravity-client"`)
- Fallback: `CONTEXT_MODE_PLATFORM=antigravity` environment variable override

**Routing Instructions:**
- `GEMINI.md` auto-written at project root on first MCP server startup
- Antigravity reads `GEMINI.md` natively (same filename as Gemini CLI, different content — no hook references)

**Capabilities:**
- PreToolUse: --
- PostToolUse: --
- PreCompact: --
- SessionStart: --
- Can modify args: --
- Can modify output: --
- Can inject session context: --

**Known Issues / Caveats:**
- No hook support — only routing instruction files for enforcement (~60% compliance)
- Shares `~/.gemini/` directory with Gemini CLI — session DB uses project hash to prevent collision
- No verified Antigravity-specific environment variables exist

**Sources:**
- Config path: [Gemini CLI Issue #16058](https://github.com/google-gemini/gemini-cli/issues/16058)
- MCP support: [Antigravity MCP docs](https://antigravity.google/docs/mcp)
- clientInfo: [Apify MCP Client Capabilities Registry](https://github.com/apify/mcp-client-capabilities)

---

### Kiro

**Status:** MCP-only (hooks planned for Phase 2)

**Hook Paradigm:** MCP-only

Kiro is an AWS agentic IDE and CLI. It supports MCP servers via `~/.kiro/settings/mcp.json` using the standard `mcpServers` JSON format. Hook support for Kiro CLI (JSON stdin + exit code 2 blocking, `preToolUse`/`postToolUse`) is verified in the Kiro CLI docs but not yet implemented in context-mode — planned for Phase 2.

**Detection:**
- Auto-detected via MCP protocol handshake (`clientInfo.name: "Kiro CLI"`)

**Configuration:**
- Global: `~/.kiro/settings/mcp.json` (JSON format, standard `mcpServers` object)
- Project: `.kiro/settings/mcp.json`

**Routing Instructions:**
- `KIRO.md` written at project root on first MCP server startup

**Hook System (Phase 2 — not yet implemented):**
- Kiro CLI supports `preToolUse`/`postToolUse` hooks via JSON stdin
- Blocking: exit code 2 (similar to Gemini CLI pattern)
- Hook format verified in Kiro CLI docs but context-mode adapter is not yet built

**Built-in Tools:**
- `fs_read` / `read`, `fs_write` / `write`, `execute_bash` / `shell`, `use_aws` / `aws`

**Capabilities:**
- PreToolUse: --
- PostToolUse: --
- PreCompact: --
- SessionStart: --
- Can modify args: --
- Can modify output: --
- Can inject session context: --

**Known Issues / Caveats:**
- Hook adapter not yet implemented — Phase 2 work item
- Kiro IDE hooks use a UI-based "Run Command" shell action; stdin format unverified

**Sources:**
- clientInfo.name: [Kiro GitHub Issue #5205](https://github.com/kirodotdev/Kiro/issues/5205)
- MCP config: [Kiro MCP Configuration docs](https://kiro.dev/docs/mcp/configuration/)
- CLI hooks: [Kiro CLI Hooks docs](https://kiro.dev/docs/cli/hooks/)

---

### VS Code Copilot

**Status:** Fully supported (preview)

**Hook Paradigm:** JSON stdin/stdout

VS Code Copilot uses the same JSON stdin/stdout paradigm as Claude Code with PascalCase hook names. It also provides unique hooks for subagent lifecycle.

**Hook Names:**
- `PreToolUse` -- fires before a tool is executed
- `PostToolUse` -- fires after a tool completes
- `PreCompact` -- fires before context compaction
- `SessionStart` -- fires when a session starts
- `Stop` -- fires when agent stops (unique to VS Code)
- `SubagentStart` -- fires when a subagent starts (unique to VS Code)
- `SubagentStop` -- fires when a subagent stops (unique to VS Code)

**Blocking:** `permissionDecision: "deny"` (same as Claude Code)

**Arg Modification:** `updatedInput` inside `hookSpecificOutput` wrapper (NOT flat like Claude Code)
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "updatedInput": { ... }
  }
}
```

**Output Modification:** `additionalContext` inside `hookSpecificOutput`, or `decision: "block"` + `reason`

**MCP Tool Naming:** Uses `f1e_` prefix (not `mcp__server__tool`)

**Session ID:** `sessionId` (camelCase, not `session_id`)

**Configuration:**
- Primary: `.github/hooks/*.json`
- Also reads: `.claude/settings.json`
- MCP config: `.vscode/mcp.json`

**Environment Detection:**
- `VSCODE_PID` environment variable
- `TERM_PROGRAM=vscode`

**Hook Commands:**
```
context-mode hook vscode-copilot pretooluse
context-mode hook vscode-copilot posttooluse
context-mode hook vscode-copilot precompact
context-mode hook vscode-copilot sessionstart
```

**Known Issues / Caveats:**
- Preview status -- API may change without notice
- Matchers are parsed but IGNORED (all hooks fire on all tools)
- Tool input property names use camelCase (`filePath` not `file_path`)
- Response must be wrapped in `hookSpecificOutput` with `hookEventName`

---

### JetBrains Copilot

**Status:** Fully supported (preview)

**Hook Paradigm:** JSON stdin/stdout

JetBrains Copilot (GitHub Copilot plugin for JetBrains IDEs) uses the same JSON stdin/stdout paradigm and hook wire protocol as VS Code Copilot. It shares hook names, response format, and MCP tool naming conventions.

**Hook Names:**
- `PreToolUse` -- fires before a tool is executed
- `PostToolUse` -- fires after a tool completes
- `PreCompact` -- fires before context compaction
- `SessionStart` -- fires when a session starts
- `Stop` -- fires when agent stops
- `SubagentStart` -- fires when a subagent starts
- `SubagentStop` -- fires when a subagent stops

**Blocking:** `permissionDecision: "deny"` (same as VS Code Copilot)

**Arg Modification:** `updatedInput` inside `hookSpecificOutput` wrapper (same as VS Code Copilot)
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "updatedInput": { ... }
  }
}
```

**Output Modification:** `additionalContext` inside `hookSpecificOutput`, or `decision: "block"` + `reason`

**MCP Tool Naming:** Uses `f1e_` prefix (same as VS Code Copilot)

**Session ID:** `sessionId` (camelCase)

**Configuration:**
- Hook config: `.github/hooks/*.json`
- MCP config: Settings UI (Settings > Tools > AI Assistant > MCP)

**Hook Commands:**
```
context-mode hook jetbrains-copilot pretooluse
context-mode hook jetbrains-copilot posttooluse
context-mode hook jetbrains-copilot precompact
context-mode hook jetbrains-copilot sessionstart
```

**Known Issues / Caveats:**
- Preview status -- API may change without notice
- Shares the same hook wire protocol as VS Code Copilot
- MCP servers are configured via Settings UI, not a file
- Requires GitHub Copilot plugin v1.5.57+

---

### Cursor

**Status:** Supported (native hooks, v1 scope)

**Hook Paradigm:** JSON stdin/stdout

Cursor uses native lower-camel hook names and flat hook entries in `.cursor/hooks.json` or `~/.cursor/hooks.json`. context-mode treats Cursor as a first-class adapter and does not rely on Claude-compat wrappers for official support.

**Hook Names:**
- `preToolUse` -- fires before a tool is executed
- `postToolUse` -- fires after a tool completes
- `stop` -- fires when agent turn ends (can send followup_message to continue loop)
- `afterAgentResponse` -- fires after assistant response (fire-and-forget, receives full response text)
- `sessionStart` -- documented but currently rejected by Cursor's validator ([forum report](https://forum.cursor.com/t/unknown-hook-type-sessionstart/149566))

**Blocking:** `{ "permission": "deny", "user_message": "..." }`

**Arg Modification:** not natively supported (Cursor does not have `updated_input`)

**Output Modification:** not supported in v1

**Session Context Injection:** `{ "additional_context": "..." }`

**Session ID Extraction Priority:**
1. `conversation_id` (stdin JSON)
2. `CURSOR_TRACE_ID` environment variable
3. Parent process ID fallback

**Platform Detection Env Vars:**
- `CURSOR_TRACE_ID` (MCP server context)
- `CURSOR_CLI` (integrated terminal context)
- `~/.cursor/` directory fallback (medium confidence)

**Configuration:**
- Project: `.cursor/hooks.json`
- User: `~/.cursor/hooks.json`
- MCP config: `.cursor/mcp.json` or `~/.cursor/mcp.json`

**Hook Commands:**
```
context-mode hook cursor pretooluse
context-mode hook cursor posttooluse
context-mode hook cursor stop
```

**Known Issues / Caveats:**
- `preCompact` is intentionally not shipped in v1
- `stop` hook receives: `conversation_id`, `status`, `loop_count`, `transcript_path`; returns `followup_message` to continue
- `afterAgentResponse` is fire-and-forget (receives `text`, no return value expected)
- Hook payloads name MCP tools as `MCP:<tool>` and need adapter normalization
- Claude-compatible Cursor behavior exists, but native Cursor config is the supported path
- `additional_context` in postToolUse and sessionStart hooks is accepted but NOT surfaced to the model (Cursor upstream bug — [forum #155689](https://forum.cursor.com/t/native-posttooluse-hooks-accept-and-log-additional-context-successfully-but-the-injected-context-is-not-surfaced-to-the-model/155689), [forum #156157](https://forum.cursor.com/t/cursor-hooks-additional-context-not-injected-in-agent-context-in-posttooluse/156157)). Routing enforcement relies on `.mdc` rules file and MCP tool descriptions instead.

---

### OpenClaw

**Status:** Fully supported

**Hook Paradigm:** TS Plugin (gateway plugin via `api.registerHook()` / `api.on()`)

OpenClaw is an OpenAI-stack agent gateway. context-mode ships as a native gateway plugin that registers hooks through OpenClaw's plugin API rather than the JSON stdin/stdout wire protocol. The same plugin entry also registers context-mode as a context engine, owning compaction.

**Hook Names:**
- `tool_call:before` -- equivalent to PreToolUse
- `tool_call:after` -- equivalent to PostToolUse
- `command:new` -- equivalent to SessionStart (fires on each new gateway command)
- `before_prompt_build` -- lifecycle hook for routing instruction injection
- `registerContextEngine` (with `ownsCompaction`) -- equivalent to PreCompact

**Blocking:** `return { block: true, blockReason: "..." }` from the `tool_call:before` handler

**Arg Modification:** mutate `event.params` in the `tool_call:before` handler (or return `{ params: ... }`)

**Output Modification:** not supported (the plugin paradigm exposes args/context, not the rendered tool output)

**Context Injection:** via `before_prompt_build` (session-level) and `registerContextEngine` (compaction-level)

**Path Resolution:**
- Detection root: `~/.openclaw/`
- Plugin install: `~/.openclaw/extensions/context-mode/`
- Project config: `openclaw.json` or `.openclaw/openclaw.json`
- Global config fallback: `~/.openclaw/openclaw.json`
- Project dir: `process.cwd()` (the gateway provides no dedicated env var)
- Memory dir: project-relative `./memory`
- Session dir: `~/.openclaw/context-mode/sessions/`
- Routing instructions: `AGENTS.md`

**Configuration:**
- `openclaw.json` registers context-mode under `plugins.entries["context-mode"]` (`{ "enabled": true }`)
- `plugins.slots.contextEngine = "context-mode"` enables ownership of compaction
- No CLI hook command; OpenClaw imports the plugin module directly

**Notes / Caveats:**
- TS plugin paradigm — hooks run in-process, so there is no shell command to chmod and no platform-specific stdin/stdout quirks
- `ask` decisions are converted to `block` (with the original reason) since the gateway has no interactive confirmation path
- `context` decisions inside `tool_call:before` are dropped — context injection must be routed through `before_prompt_build` or the registered context engine
- Session ID falls back to `pid-${process.ppid}` when the gateway does not surface one

---

### Zed

**Status:** MCP-only (no hooks)

**Hook Paradigm:** MCP-only

Zed is a code editor with first-class MCP support but no hook pipeline. context-mode runs purely through Zed's `context_servers` configuration; routing enforcement falls back to the AGENTS.md instruction file (~60% compliance).

**Hook Support:**
- PreToolUse: --
- PostToolUse: --
- PreCompact: --
- SessionStart: --
- Stop: --
- Can modify args: --
- Can modify output: --
- Can inject session context: --

The hook adapter exists only to satisfy the interface contract — every parser throws `Error("Zed does not support hooks")` and every formatter returns `undefined`.

**Path Resolution:**
- Detection root: `~/.config/zed/`
- Settings file: `~/.config/zed/settings.json`
- MCP registration: `context_servers` object inside `settings.json`
- Session dir: `~/.config/zed/context-mode/sessions/`
- Routing instructions: `AGENTS.md` (sourced from `configs/zed/AGENTS.md` in the package, with an inline fallback if missing)

**Detection:**
- Auto-detected via the presence of `~/.config/zed/`
- Override via `CONTEXT_MODE_PLATFORM=zed`

**Notes / Caveats:**
- No hook adapter implies no automatic routing — the model must follow AGENTS.md voluntarily
- No marketplace or plugin registry for Zed; `getInstalledVersion()` always reports `not installed`
- `validateHooks` always returns a single `warn` row reminding the user that Zed exposes only MCP integration
- `configureAllHooks`, `setHookPermissions`, and `updatePluginRegistry` are intentional no-ops

---

## Capability Matrix (Quick Reference)

| Capability | Claude Code | Gemini CLI | VS Code Copilot | JetBrains Copilot | Cursor | OpenCode | Codex CLI | Antigravity | Kiro |
|-----------|:-----------:|:----------:|:---------------:|:-----------------:|:------:|:--------:|:---------:|:-----------:|:----:|
| PreToolUse | Yes | Yes | Yes | Yes | Yes | Yes | Yes*** | -- | -- |
| PostToolUse | Yes | Yes | Yes | Yes | Yes | Yes | Yes | -- | -- |
| PreCompact | Yes | Yes | Yes | Yes | -- | Yes* | -- | -- | -- |
| SessionStart | Yes | Yes | Yes | Yes | Yes | -- | Yes | -- | -- |
| Stop | -- | -- | Yes | Yes | Yes | -- | Yes | -- | -- |
| Modify Args | Yes | Yes | Yes | Yes | Yes | Yes | -- | -- | -- |
| Modify Output | Yes | Yes | Yes | Yes | No | Yes** | -- | -- | -- |
| Inject Context | Yes | Yes | Yes | Yes | Yes | -- | Yes | -- | -- |
| Block Tools | Yes | Yes | Yes | Yes | Yes | Yes | Yes | -- | -- |
| MCP Support | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

\* OpenCode `experimental.session.compacting` is experimental
\*\* OpenCode has a TUI rendering bug for bash tool output (#13575)
\*\*\* Codex CLI PreToolUse supports deny only (no `additionalContext`); context injection works via PostToolUse and SessionStart

---

## Hook Response Format Comparison

### Blocking a Tool

| Platform | Response Format |
|----------|----------------|
| Claude Code | `{ "permissionDecision": "deny", "reason": "..." }` |
| Gemini CLI | `{ "decision": "deny", "reason": "..." }` |
| VS Code Copilot | `{ "permissionDecision": "deny", "reason": "..." }` |
| JetBrains Copilot | `{ "permissionDecision": "deny", "reason": "..." }` |
| Cursor | `{ "permission": "deny", "user_message": "..." }` |
| OpenCode | `throw new Error("...")` |
| Codex CLI | `{ "hookSpecificOutput": { "permissionDecision": "deny" } }` or exit code 2 |

### Modifying Tool Input

| Platform | Response Format |
|----------|----------------|
| Claude Code | `{ "updatedInput": { ... } }` |
| Gemini CLI | `{ "hookSpecificOutput": { "tool_input": { ... } } }` |
| VS Code Copilot | `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "updatedInput": { ... } } }` |
| JetBrains Copilot | `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "updatedInput": { ... } } }` |
| Cursor | `{ "updated_input": { ... } }` |
| OpenCode | `{ "args": { ... } }` (mutation) |
| Codex CLI | N/A (updatedInput in schema but not implemented) |

### Injecting Additional Context (PostToolUse)

| Platform | Response Format |
|----------|----------------|
| Claude Code | `{ "additionalContext": "..." }` |
| Gemini CLI | `{ "hookSpecificOutput": { "additionalContext": "..." } }` |
| VS Code Copilot | `{ "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": "..." } }` |
| JetBrains Copilot | `{ "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": "..." } }` |
| Cursor | `{ "additional_context": "..." }` |
| OpenCode | `{ "additionalContext": "..." }` |
| Codex CLI | `{ "hookSpecificOutput": { "additionalContext": "..." } }` |

---

## CLI Hook Dispatcher

All hook-based platforms use the CLI dispatcher pattern instead of direct `node` paths:

```
context-mode hook <platform> <event>
```

The dispatcher resolves the hook script relative to the installed package and dynamically imports it. Stdin/stdout flow through naturally since it runs in the same process.

**Advantages over `node ./node_modules/...` paths:**
- Works from any directory (no per-project `npm install` needed)
- Single global install serves all projects
- `context-mode upgrade` updates hooks in-place
- Short, portable command strings in settings files

**Supported dispatches:**

| Platform | Events |
|----------|--------|
| `claude-code` | `pretooluse`, `posttooluse`, `precompact`, `sessionstart`, `userpromptsubmit` |
| `gemini-cli` | `beforetool`, `aftertool`, `precompress`, `sessionstart` |
| `vscode-copilot` | `pretooluse`, `posttooluse`, `precompact`, `sessionstart` |
| `jetbrains-copilot` | `pretooluse`, `posttooluse`, `precompact`, `sessionstart` |
| `cursor` | `pretooluse`, `posttooluse`, `stop` |
| `codex` | `pretooluse`, `posttooluse`, `sessionstart` |

OpenCode uses a TS plugin paradigm (no command dispatcher). Antigravity and Kiro have no hook support.

---

## SQLite Backend Selection

context-mode automatically selects the best SQLite backend at runtime based on the environment:

| Priority | Condition | Backend | Why |
|----------|-----------|---------|-----|
| 1 | Bun runtime | `bun:sqlite` | Built-in, no native addon |
| 2 | Linux + Node.js >= 22.13 | `node:sqlite` | Built-in, avoids [SIGSEGV from V8 madvise bug](https://github.com/nodejs/node/issues/62515) |
| 3 | All other environments | `better-sqlite3` | Mature native addon, prebuilt binaries |

**Why node:sqlite on Linux?** Node.js's V8 garbage collector can call `madvise(MADV_DONTNEED)` on memory ranges that overlap `better-sqlite3`'s native addon `.got.plt` section, corrupting resolved symbol addresses and causing sporadic SIGSEGV crashes (1-4/hour on Node v22-v24). `node:sqlite` is compiled into the Node.js binary itself — no separate `.node` file, no `dlopen()`, no `.got.plt` to corrupt.

**Fallback:** If `node:sqlite` is unavailable (Node < 22.13), context-mode silently falls back to `better-sqlite3`. No user configuration needed.

**Override:** Not currently supported — backend selection is automatic. If you need to force a specific backend, open an issue.

---

## Utility Commands

All platforms support utility commands via MCP meta-tools:

| Command | What it does |
|---------|-------------|
| `ctx stats` | Show context savings, call counts, and session statistics |
| `ctx doctor` | Diagnose installation: runtimes, hooks, FTS5, versions |
| `ctx upgrade` | Update from GitHub, rebuild, reconfigure hooks |
| `ctx purge` | Permanently deletes all indexed content from the knowledge base |

**How they work:** The MCP server exposes `stats`, `doctor`, `upgrade`, and `purge` tools. The `<ctx_commands>` section in routing instructions (CLAUDE.md, GEMINI.md, AGENTS.md, copilot-instructions.md) maps natural language triggers to MCP tool calls. The `doctor` and `upgrade` tools return shell commands that the LLM executes and formats as a checklist. The `purge` tool permanently deletes all indexed content from the knowledge base and is the sole reset mechanism.
