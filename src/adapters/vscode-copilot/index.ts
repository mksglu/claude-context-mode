/**
 * adapters/vscode-copilot — VS Code Copilot platform adapter.
 *
 * Implements HookAdapter for VS Code Copilot's JSON stdin/stdout hook paradigm.
 *
 * VS Code Copilot hook specifics:
 *   - I/O: JSON on stdin, JSON on stdout (same paradigm as Claude Code)
 *   - Hook names: PreToolUse, PostToolUse, PreCompact, SessionStart (PascalCase)
 *   - Additional hooks: Stop, SubagentStart, SubagentStop (unique to VS Code)
 *   - Arg modification: `updatedInput` in hookSpecificOutput wrapper (NOT flat)
 *   - Blocking: `permissionDecision: "deny"` (same as Claude Code)
 *   - Output modification: `additionalContext` in hookSpecificOutput,
 *     `decision: "block"` + reason
 *   - Tool input fields: tool_name, tool_input (snake_case, same as Claude Code)
 *   - But tool input PROPERTY names are camelCase (filePath not file_path)
 *   - Session ID: sessionId (camelCase, NOT session_id)
 *   - MCP tool prefix: f1e_ (not mcp__server__tool)
 *   - CRITICAL: matchers are parsed but IGNORED (all hooks fire on all tools)
 *   - Config: .github/hooks/*.json (primary), also reads .claude/settings.json
 *   - Env detection: VSCODE_PID, TERM_PROGRAM=vscode
 *   - Session dir: ~/.vscode/context-mode/sessions/ (fallback)
 *   - Preview status — API may change
 */

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  accessSync,
  existsSync,
  chmodSync,
  constants,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import type {
  HookAdapter,
  HookParadigm,
  PlatformCapabilities,
  DiagnosticResult,
  PreToolUseEvent,
  PostToolUseEvent,
  PreCompactEvent,
  SessionStartEvent,
  PreToolUseResponse,
  PostToolUseResponse,
  PreCompactResponse,
  SessionStartResponse,
  HookRegistration,
} from "../types.js";

// ─────────────────────────────────────────────────────────
// VS Code Copilot raw input types
// ─────────────────────────────────────────────────────────

interface VSCodeCopilotHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  is_error?: boolean;
  /** VS Code Copilot uses camelCase sessionId (NOT session_id). */
  sessionId?: string;
  source?: string;
}

// ─────────────────────────────────────────────────────────
// Hook constants (re-exported from hooks.ts)
// ─────────────────────────────────────────────────────────

import {
  HOOK_TYPES as VSCODE_HOOK_NAMES,
  HOOK_SCRIPTS as VSCODE_HOOK_SCRIPTS,
  buildHookCommand as buildVSCodeHookCommand,
  type HookType as VSCodeHookType,
} from "./hooks.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class VSCodeCopilotAdapter implements HookAdapter {
  readonly name = "VS Code Copilot";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    canModifyArgs: true,
    canModifyOutput: true,
    canInjectSessionContext: true,
  };

  // ── Input parsing ──────────────────────────────────────

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as VSCodeCopilotHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as VSCodeCopilotHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      toolOutput: input.tool_output,
      isError: input.is_error,
      sessionId: this.extractSessionId(input),
      projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  parsePreCompactInput(raw: unknown): PreCompactEvent {
    const input = raw as VSCodeCopilotHookInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as VSCodeCopilotHookInput;
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
      projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  // ── Response formatting ────────────────────────────────

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    if (response.decision === "deny") {
      return {
        permissionDecision: "deny",
        reason: response.reason ?? "Blocked by context-mode hook",
      };
    }
    if (response.decision === "modify" && response.updatedInput) {
      // VS Code Copilot: updatedInput is wrapped in hookSpecificOutput
      return {
        hookSpecificOutput: {
          hookEventName: VSCODE_HOOK_NAMES.PRE_TOOL_USE,
          updatedInput: response.updatedInput,
        },
      };
    }
    if (response.decision === "context" && response.additionalContext) {
      // VS Code Copilot: inject additionalContext via hookSpecificOutput
      return {
        hookSpecificOutput: {
          hookEventName: VSCODE_HOOK_NAMES.PRE_TOOL_USE,
          additionalContext: response.additionalContext,
        },
      };
    }
    if (response.decision === "ask") {
      // VS Code Copilot: use deny to force user attention (no native "ask")
      return {
        permissionDecision: "deny",
        reason: response.reason ?? "Action requires user confirmation (security policy)",
      };
    }
    // "allow" — return undefined for passthrough
    return undefined;
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    if (response.updatedOutput) {
      // VS Code Copilot: decision "block" + reason for output replacement
      return {
        hookSpecificOutput: {
          hookEventName: VSCODE_HOOK_NAMES.POST_TOOL_USE,
          decision: "block",
          reason: response.updatedOutput,
        },
      };
    }
    if (response.additionalContext) {
      return {
        hookSpecificOutput: {
          hookEventName: VSCODE_HOOK_NAMES.POST_TOOL_USE,
          additionalContext: response.additionalContext,
        },
      };
    }
    return undefined;
  }

  formatPreCompactResponse(response: PreCompactResponse): unknown {
    // VS Code Copilot: stdout content on exit 0 is injected as context
    return response.context ?? "";
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    // VS Code Copilot: stdout content is injected as additional context
    return response.context ?? "";
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    // VS Code Copilot primarily uses .github/hooks/*.json
    // but also reads .claude/settings.json
    return resolve(".github", "hooks", "context-mode.json");
  }

  getSessionDir(): string {
    // Prefer .github/context-mode/sessions/ if .github exists,
    // otherwise fall back to ~/.vscode/context-mode/sessions/
    const githubDir = resolve(".github", "context-mode", "sessions");
    const fallbackDir = join(
      homedir(),
      ".vscode",
      "context-mode",
      "sessions",
    );

    const dir = existsSync(resolve(".github")) ? githubDir : fallbackDir;
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  getSessionDBPath(projectDir: string): string {
    const hash = createHash("sha256")
      .update(projectDir)
      .digest("hex")
      .slice(0, 16);
    return join(this.getSessionDir(), `${hash}.db`);
  }

  getSessionEventsPath(projectDir: string): string {
    const hash = createHash("sha256")
      .update(projectDir)
      .digest("hex")
      .slice(0, 16);
    return join(this.getSessionDir(), `${hash}-events.md`);
  }

  generateHookConfig(pluginRoot: string): HookRegistration {
    return {
      [VSCODE_HOOK_NAMES.PRE_TOOL_USE]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildVSCodeHookCommand(VSCODE_HOOK_NAMES.PRE_TOOL_USE, pluginRoot),
            },
          ],
        },
      ],
      [VSCODE_HOOK_NAMES.POST_TOOL_USE]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildVSCodeHookCommand(VSCODE_HOOK_NAMES.POST_TOOL_USE, pluginRoot),
            },
          ],
        },
      ],
      [VSCODE_HOOK_NAMES.PRE_COMPACT]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildVSCodeHookCommand(VSCODE_HOOK_NAMES.PRE_COMPACT, pluginRoot),
            },
          ],
        },
      ],
      [VSCODE_HOOK_NAMES.SESSION_START]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildVSCodeHookCommand(VSCODE_HOOK_NAMES.SESSION_START, pluginRoot),
            },
          ],
        },
      ],
    };
  }

  readSettings(): Record<string, unknown> | null {
    // Try .github/hooks/context-mode.json first, then .claude/settings.json
    const paths = [
      this.getSettingsPath(),
      resolve(".claude", "settings.json"),
    ];
    for (const configPath of paths) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    return null;
  }

  writeSettings(settings: Record<string, unknown>): void {
    const configPath = this.getSettingsPath();
    const dir = resolve(".github", "hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(settings, null, 2) + "\n",
      "utf-8",
    );
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];

    // Check .github/hooks/ directory for hook JSON files
    const hooksDir = resolve(".github", "hooks");
    try {
      accessSync(hooksDir, constants.R_OK);
    } catch {
      results.push({
        check: "Hooks directory",
        status: "fail",
        message: ".github/hooks/ directory not found",
        fix: "context-mode upgrade",
      });
      return results;
    }

    // Check for context-mode hook config
    const hookConfigPath = resolve(hooksDir, "context-mode.json");
    try {
      const raw = readFileSync(hookConfigPath, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const hooks = config.hooks as Record<string, unknown> | undefined;

      // Check PreToolUse
      if (hooks?.[VSCODE_HOOK_NAMES.PRE_TOOL_USE]) {
        results.push({
          check: "PreToolUse hook",
          status: "pass",
          message: "PreToolUse hook configured in context-mode.json",
        });
      } else {
        results.push({
          check: "PreToolUse hook",
          status: "fail",
          message: "PreToolUse not found in context-mode.json",
          fix: "context-mode upgrade",
        });
      }

      // Check SessionStart
      if (hooks?.[VSCODE_HOOK_NAMES.SESSION_START]) {
        results.push({
          check: "SessionStart hook",
          status: "pass",
          message: "SessionStart hook configured in context-mode.json",
        });
      } else {
        results.push({
          check: "SessionStart hook",
          status: "fail",
          message: "SessionStart not found in context-mode.json",
          fix: "context-mode upgrade",
        });
      }
    } catch {
      results.push({
        check: "Hook configuration",
        status: "fail",
        message: "Could not read .github/hooks/context-mode.json",
        fix: "context-mode upgrade",
      });
    }

    // Warn about preview status
    results.push({
      check: "API stability",
      status: "warn",
      message:
        "VS Code Copilot hooks are in preview — API may change without notice",
    });

    // Warn about matcher behavior
    results.push({
      check: "Matcher support",
      status: "warn",
      message:
        "Matchers are parsed but IGNORED — all hooks fire on all tools",
    });

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    // Check MCP config in .vscode/mcp.json
    try {
      const mcpConfigPath = resolve(".vscode", "mcp.json");
      const raw = readFileSync(mcpConfigPath, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;

      const servers = config.servers as Record<string, unknown> | undefined;
      if (servers) {
        const hasPlugin = Object.keys(servers).some((k) =>
          k.includes("context-mode"),
        );
        if (hasPlugin) {
          return {
            check: "MCP registration",
            status: "pass",
            message: "context-mode found in .vscode/mcp.json",
          };
        }
      }

      return {
        check: "MCP registration",
        status: "fail",
        message: "context-mode not found in .vscode/mcp.json",
        fix: "Add context-mode server to .vscode/mcp.json",
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: "Could not read .vscode/mcp.json",
      };
    }
  }

  getInstalledVersion(): string {
    // Check VS Code extensions for context-mode
    const extensionDirs = [
      join(homedir(), ".vscode", "extensions"),
      join(homedir(), ".vscode-insiders", "extensions"),
    ];

    for (const extDir of extensionDirs) {
      try {
        const entries = readFileSync(
          join(extDir, "extensions.json"),
          "utf-8",
        );
        const exts = JSON.parse(entries) as Array<Record<string, unknown>>;
        const contextMode = exts.find(
          (e) =>
            typeof e.identifier === "object" &&
            e.identifier !== null &&
            (
              e.identifier as Record<string, unknown>
            ).id?.toString().includes("context-mode"),
        );
        if (contextMode && typeof contextMode.version === "string") {
          return contextMode.version;
        }
      } catch {
        continue;
      }
    }
    return "not installed";
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(pluginRoot: string): string[] {
    const changes: string[] = [];
    const hookConfig: Record<string, unknown> = { hooks: {} };
    const hooks = hookConfig.hooks as Record<string, unknown>;

    const hookTypes = [
      VSCODE_HOOK_NAMES.PRE_TOOL_USE,
      VSCODE_HOOK_NAMES.POST_TOOL_USE,
      VSCODE_HOOK_NAMES.PRE_COMPACT,
      VSCODE_HOOK_NAMES.SESSION_START,
    ];

    for (const hookType of hookTypes) {
      const script = VSCODE_HOOK_SCRIPTS[hookType];
      if (!script) continue;

      hooks[hookType] = [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildVSCodeHookCommand(hookType, pluginRoot),
            },
          ],
        },
      ];
      changes.push(`Configured ${hookType} hook`);
    }

    // Write to .github/hooks/context-mode.json
    const outputDir = resolve(".github", "hooks");
    mkdirSync(outputDir, { recursive: true });
    const outputPath = resolve(outputDir, "context-mode.json");
    writeFileSync(
      outputPath,
      JSON.stringify(hookConfig, null, 2) + "\n",
      "utf-8",
    );
    changes.push(`Wrote hook config to ${outputPath}`);

    return changes;
  }

  backupSettings(): string | null {
    const settingsPath = this.getSettingsPath();
    try {
      accessSync(settingsPath, constants.R_OK);
      const backupPath = settingsPath + ".bak";
      copyFileSync(settingsPath, backupPath);
      return backupPath;
    } catch {
      return null;
    }
  }

  setHookPermissions(pluginRoot: string): string[] {
    const set: string[] = [];
    const hooksDir = join(pluginRoot, "hooks", "vscode-copilot");
    for (const scriptName of Object.values(VSCODE_HOOK_SCRIPTS)) {
      const scriptPath = resolve(hooksDir, scriptName);
      try {
        accessSync(scriptPath, constants.R_OK);
        chmodSync(scriptPath, 0o755);
        set.push(scriptPath);
      } catch {
        /* skip missing scripts */
      }
    }
    return set;
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // VS Code manages extensions through its own marketplace/extension system.
    // No manual registry update needed.
  }

  // ── Internal helpers ───────────────────────────────────

  /**
   * Extract session ID from VS Code Copilot hook input.
   * VS Code Copilot uses camelCase sessionId (NOT session_id).
   */
  private extractSessionId(input: VSCodeCopilotHookInput): string {
    if (input.sessionId) return input.sessionId;
    if (process.env.VSCODE_PID) return `vscode-${process.env.VSCODE_PID}`;
    return `pid-${process.ppid}`;
  }
}
