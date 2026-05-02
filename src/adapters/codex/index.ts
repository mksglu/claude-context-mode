/**
 * adapters/codex — Codex CLI platform adapter.
 *
 * Implements HookAdapter for Codex CLI's JSON stdin/stdout paradigm.
 *
 * Codex CLI hook specifics:
 *   - 5 hook events: PreToolUse, PostToolUse, SessionStart, UserPromptSubmit, Stop
 *   - Same wire protocol as Claude Code (JSON stdin → stdout)
 *   - Config: ~/.codex/hooks.json + ~/.codex/config.toml (TOML for MCP/features)
 *   - Session dir: ~/.codex/context-mode/sessions/
 *
 * Hook dispatch is stable in Codex CLI. PreToolUse deny decisions work,
 * while input rewriting remains blocked on upstream updatedInput support.
 * Track: https://github.com/openai/codex/issues/18491
 */

import {
  readFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { BaseAdapter } from "../base.js";

import {
  buildNodeCommand,
  type HookAdapter,
  type HookParadigm,
  type PlatformCapabilities,
  type DiagnosticResult,
  type PreToolUseEvent,
  type PostToolUseEvent,
  type PreCompactEvent,
  type SessionStartEvent,
  type PreToolUseResponse,
  type PostToolUseResponse,
  type PreCompactResponse,
  type SessionStartResponse,
  type HookRegistration,
} from "../types.js";

// ─────────────────────────────────────────────────────────
// Codex CLI raw input types
// ─────────────────────────────────────────────────────────

interface CodexHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
  permission_mode?: string;
  tool_use_id?: string;
  transcript_path?: string | null;
  turn_id?: string;
  source?: string;
}

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class CodexAdapter extends BaseAdapter implements HookAdapter {
  constructor() {
    super([".codex"]);
  }

  readonly name = "Codex CLI";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: false,
    sessionStart: true,
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: true,
  };

  // ── Input parsing ──────────────────────────────────────

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as CodexHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as CodexHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      toolOutput: input.tool_response,
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  parsePreCompactInput(raw: unknown): PreCompactEvent {
    const input = raw as CodexHookInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as CodexHookInput;
    const rawSource = input.source ?? "startup";

    let source: SessionStartEvent["source"];
    switch (rawSource) {
      case "compact":
        source = "compact";
        break;
      case "resume":
        source = "resume";
        break;
      case "clear":
        source = "clear";
        break;
      default:
        source = "startup";
    }

    return {
      sessionId: this.extractSessionId(input),
      source,
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  // ── Response formatting ────────────────────────────────
  // Codex CLI uses hookSpecificOutput wrapper for all hook responses.
  // Unlike Claude Code, Codex does NOT support updatedInput or updatedMCPToolOutput.

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    if (response.decision === "deny") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            response.reason ?? "Blocked by context-mode hook",
        },
      };
    }
    if (response.decision === "context" && response.additionalContext) {
      // Codex does not support additionalContext in PreToolUse (fails open).
      // Context injection works via PostToolUse and SessionStart instead.
      return {};
    }
    // "allow" — return empty object for passthrough
    return {};
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    if (response.additionalContext) {
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: response.additionalContext,
        },
      };
    }
    return {};
  }

  formatPreCompactResponse(response: PreCompactResponse): unknown {
    if (response.context) {
      return {
        hookSpecificOutput: {
          additionalContext: response.context,
        },
      };
    }
    return {};
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    if (response.context) {
      return {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: response.context,
        },
      };
    }
    return {};
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    return resolve(homedir(), ".codex", "config.toml");
  }

  getInstructionFiles(): string[] {
    // Codex CLI honors AGENTS.md plus an optional override file.
    return ["AGENTS.md", "AGENTS.override.md"];
  }

  getMemoryDir(): string {
    // Codex uses "memories" (plural), not the default "memory".
    return resolve(homedir(), ".codex", "memories");
  }

  generateHookConfig(pluginRoot: string): HookRegistration {
    return {
      PreToolUse: [
        {
          matcher: "local_shell|shell|shell_command|exec_command|container.exec|Bash|Shell|grep_files|mcp__plugin_context-mode_context-mode__ctx_execute|mcp__plugin_context-mode_context-mode__ctx_execute_file|mcp__plugin_context-mode_context-mode__ctx_batch_execute",
          hooks: [
            {
              type: "command",
              command: buildNodeCommand(`${pluginRoot}/hooks/pretooluse.mjs`),
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildNodeCommand(`${pluginRoot}/hooks/posttooluse.mjs`),
            },
          ],
        },
      ],
      SessionStart: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildNodeCommand(`${pluginRoot}/hooks/sessionstart.mjs`),
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildNodeCommand(`${pluginRoot}/hooks/codex/userpromptsubmit.mjs`),
            },
          ],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildNodeCommand(`${pluginRoot}/hooks/codex/stop.mjs`),
            },
          ],
        },
      ],
    };
  }

  readSettings(): Record<string, unknown> | null {
    // Codex CLI uses TOML format. Full TOML parsing is complex;
    // return null for now. MCP configuration should be done manually
    // or via a dedicated TOML library in the upgrade flow.
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      // Return raw TOML as a single-key object for inspection
      return { _raw_toml: raw };
    } catch {
      return null;
    }
  }

  writeSettings(_settings: Record<string, unknown>): void {
    // Codex CLI uses TOML format. Writing TOML requires a dedicated
    // serializer. This is a no-op; TOML config should be edited
    // manually or via the `codex` CLI tool.
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    return [
      {
        check: "Hook support",
        status: "pass",
        message:
          "Codex CLI hooks are stable. Configure ~/.codex/hooks.json for PreToolUse, PostToolUse, SessionStart, UserPromptSubmit, and Stop.",
      },
    ];
  }

  checkPluginRegistration(): DiagnosticResult {
    // Check for context-mode in [mcp_servers] section of config.toml
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      const hasContextMode = raw.includes("context-mode");
      const hasMcpSection =
        raw.includes("[mcp_servers]") || raw.includes("[mcp_servers.");

      if (hasContextMode && hasMcpSection) {
        return {
          check: "MCP registration",
          status: "pass",
          message: "context-mode found in [mcp_servers] config",
        };
      }

      if (hasMcpSection) {
        return {
          check: "MCP registration",
          status: "fail",
          message:
            "[mcp_servers] section exists but context-mode not found",
          fix: 'Add context-mode to [mcp_servers] in ~/.codex/config.toml',
        };
      }

      return {
        check: "MCP registration",
        status: "fail",
        message: "No [mcp_servers] section in config.toml",
        fix: 'Add [mcp_servers.context-mode] to ~/.codex/config.toml',
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: "Could not read ~/.codex/config.toml",
      };
    }
  }

  getInstalledVersion(): string {
    // Codex CLI has no marketplace or plugin system
    return "not installed";
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(_pluginRoot: string): string[] {
    // Codex CLI hook configuration is done via hooks.json, not config.toml
    return [];
  }



  setHookPermissions(_pluginRoot: string): string[] {
    // Hook permissions are set during plugin install
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // Codex CLI has no plugin registry
  }

  getRoutingInstructions(): string {
    const instructionsPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "configs",
      "codex",
      "AGENTS.md",
    );
    try {
      return readFileSync(instructionsPath, "utf-8");
    } catch {
      // Fallback inline instructions
      return "# context-mode\n\nUse context-mode MCP tools (execute, execute_file, batch_execute, fetch_and_index, search) instead of bash/cat/curl for data-heavy operations.";
    }
  }

  // ── Internal helpers ───────────────────────────────────

  /**
   * Resolve the project directory for a Codex hook input.
   * Priority: input.cwd > CODEX_PROJECT_DIR env > process.cwd().
   * Mirrors the cursor / opencode pattern so downstream hooks always
   * receive a defined projectDir even under worktrees or when the
   * platform omits cwd from the wire payload.
   */
  private getProjectDir(input: CodexHookInput): string {
    return input.cwd ?? process.env.CODEX_PROJECT_DIR ?? process.cwd();
  }

  /**
   * Extract session ID from Codex CLI hook input.
   * Priority: session_id field > fallback to ppid.
   */
  private extractSessionId(input: CodexHookInput): string {
    if (input.session_id) return input.session_id;
    return `pid-${process.ppid}`;
  }
}
