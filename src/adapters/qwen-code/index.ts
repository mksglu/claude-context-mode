/**
 * adapters/qwen-code — Qwen Code platform adapter.
 *
 * Implements HookAdapter for Qwen Code's JSON stdin/stdout hook paradigm.
 *
 * Qwen Code hook specifics:
 *   - I/O: JSON on stdin, JSON on stdout (identical to Claude Code)
 *   - Arg modification: `updatedInput` field in response
 *   - Blocking: `permissionDecision: "deny"` in response
 *   - PostToolUse output: `updatedMCPToolOutput` field
 *   - PreCompact: stdout on exit 0
 *   - Session ID: session_id > QWEN_SESSION_ID > ppid
 *   - Config: ~/.qwen/settings.json
 *   - Session dir: ~/.qwen/context-mode/sessions/
 *   - MCP tool format: mcp__<server>__<tool> (standard MCP, not plugin format)
 *
 * Qwen Code supports 14 hook events — more than Claude Code:
 *   PreToolUse, PostToolUse, PostToolUseFailure, PreCompact, PostCompact,
 *   SessionStart, SessionEnd, UserPromptSubmit, Stop, StopFailure,
 *   SubagentStop, SubagentStopFailure, PermissionRequest, Notification
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
import {
  HOOK_TYPES,
  HOOK_SCRIPTS,
  REQUIRED_HOOKS,
  PRE_TOOL_USE_MATCHER_PATTERN,
  isContextModeHook,
  isAnyContextModeHook,
  extractHookScriptPath,
  buildHookCommand,
  type HookType,
} from "./hooks.js";

// ─────────────────────────────────────────────────────────
// Qwen Code raw input types
// ─────────────────────────────────────────────────────────

interface QwenCodeHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  is_error?: boolean;
  session_id?: string;
  transcript_path?: string;
  source?: string;
}

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class QwenCodeAdapter implements HookAdapter {
  readonly name = "Qwen Code";
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
    const input = raw as QwenCodeHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: process.env.QWEN_PROJECT_DIR ?? process.cwd(),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as QwenCodeHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      toolOutput: input.tool_output,
      isError: input.is_error,
      sessionId: this.extractSessionId(input),
      projectDir: process.env.QWEN_PROJECT_DIR ?? process.cwd(),
      raw,
    };
  }

  parsePreCompactInput(raw: unknown): PreCompactEvent {
    const input = raw as QwenCodeHookInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: process.env.QWEN_PROJECT_DIR ?? process.cwd(),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as QwenCodeHookInput;
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
      projectDir: process.env.QWEN_PROJECT_DIR ?? process.cwd(),
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
      return { updatedInput: response.updatedInput };
    }
    if (response.decision === "context" && response.additionalContext) {
      // Qwen Code: inject additionalContext into model context
      return { additionalContext: response.additionalContext };
    }
    if (response.decision === "ask") {
      // Qwen Code: native "ask" — prompt user for permission
      return { permissionDecision: "ask" };
    }
    // "allow" — return null/undefined for passthrough
    return undefined;
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    const result: Record<string, unknown> = {};
    if (response.additionalContext) {
      result.additionalContext = response.additionalContext;
    }
    if (response.updatedOutput) {
      result.updatedMCPToolOutput = response.updatedOutput;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  formatPreCompactResponse(response: PreCompactResponse): unknown {
    // Qwen Code: stdout content on exit 0 is injected as context
    return response.context ?? "";
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    // Qwen Code: stdout content is injected as additional context
    return response.context ?? "";
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    return resolve(homedir(), ".qwen", "settings.json");
  }

  getSessionDir(): string {
    const dir = join(homedir(), ".qwen", "context-mode", "sessions");
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
    const preToolUseCommand = `node ${pluginRoot}/hooks/pretooluse.mjs`;
    const preToolUseMatchers = [
      "run_shell_command",
      "web_fetch",
      "read_file",
      "grep_search",
      "agent",
      "mcp__context-mode__ctx_execute",
      "mcp__context-mode__ctx_execute_file",
      "mcp__context-mode__ctx_batch_execute",
    ];

    return {
      PreToolUse: preToolUseMatchers.map((matcher) => ({
        matcher,
        hooks: [{ type: "command", command: preToolUseCommand }],
      })),
      PostToolUse: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: `node ${pluginRoot}/hooks/posttooluse.mjs`,
            },
          ],
        },
      ],
      PreCompact: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: `node ${pluginRoot}/hooks/precompact.mjs`,
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
              command: `node ${pluginRoot}/hooks/userpromptsubmit.mjs`,
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
              command: `node ${pluginRoot}/hooks/sessionstart.mjs`,
            },
          ],
        },
      ],
    };
  }

  readSettings(): Record<string, unknown> | null {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  writeSettings(settings: Record<string, unknown>): void {
    writeFileSync(
      this.getSettingsPath(),
      JSON.stringify(settings, null, 2) + "\n",
      "utf-8",
    );
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const settings = this.readSettings();

    if (!settings) {
      results.push({
        check: "PreToolUse hook",
        status: "fail",
        message: "Could not read ~/.qwen/settings.json",
        fix: "context-mode upgrade",
      });
      return results;
    }

    const hooks = settings.hooks as Record<string, unknown[]> | undefined;

    // Check PreToolUse
    const hasPreToolUse = this.checkHookType(hooks, HOOK_TYPES.PRE_TOOL_USE);
    results.push({
      check: "PreToolUse hook",
      status: hasPreToolUse ? "pass" : "fail",
      message: hasPreToolUse
        ? "PreToolUse hook configured"
        : "No PreToolUse hooks found",
      fix: hasPreToolUse ? undefined : "context-mode upgrade",
    });

    // Check SessionStart
    const hasSessionStart = this.checkHookType(hooks, HOOK_TYPES.SESSION_START);
    results.push({
      check: "SessionStart hook",
      status: hasSessionStart ? "pass" : "fail",
      message: hasSessionStart
        ? "SessionStart hook configured"
        : "No SessionStart hooks found",
      fix: hasSessionStart ? undefined : "context-mode upgrade",
    });

    return results;
  }

  /** Check if a hook type is configured in settings.json */
  private checkHookType(
    settingsHooks: Record<string, unknown[]> | undefined,
    hookType: HookType,
  ): boolean {
    type HookEntry = { matcher?: string; hooks?: Array<{ command?: string }> };

    const fromSettings = settingsHooks?.[hookType] as HookEntry[] | undefined;
    if (fromSettings && fromSettings.length > 0) {
      if (fromSettings.some((entry) => isContextModeHook(entry, hookType))) {
        return true;
      }
    }

    return false;
  }

  checkPluginRegistration(): DiagnosticResult {
    // Qwen Code does not have a plugin system — hooks are registered
    // directly in settings.json. This is always a pass.
    return {
      check: "Hook registration",
      status: "pass",
      message: "Qwen Code uses direct settings.json hook registration (no plugin system)",
    };
  }

  getInstalledVersion(): string {
    // Qwen Code has no plugin registry. Check if context-mode hooks
    // are configured in settings.json as a proxy for "installed".
    const settings = this.readSettings();
    if (!settings) return "not installed";

    const hooks = settings.hooks as Record<string, unknown[]> | undefined;
    if (!hooks) return "not installed";

    const hasHooks = REQUIRED_HOOKS.some((ht) => this.checkHookType(hooks, ht));
    return hasHooks ? "installed (hooks configured)" : "not installed";
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(pluginRoot: string): string[] {
    const settings = this.readSettings() ?? {};
    const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
    const changes: string[] = [];

    // Remove stale context-mode hook entries across ALL hook types.
    // After an update or version change, settings.json may contain
    // hardcoded paths pointing to deleted version directories.
    // Clean these before registering fresh entries.
    for (const hookType of Object.keys(hooks)) {
      const entries = hooks[hookType];
      if (!Array.isArray(entries)) continue;

      const filtered = entries.filter((entry: Record<string, unknown>) => {
        const typedEntry = entry as { hooks?: Array<{ command?: string }> };
        if (!isAnyContextModeHook(typedEntry)) return true; // preserve non-context-mode hooks

        // Keep CLI dispatcher entries (path-independent, never stale)
        const commands = typedEntry.hooks ?? [];
        const hasOnlyDispatcherCommands = commands.every(
          (h) => !h.command || !extractHookScriptPath(h.command),
        );
        if (hasOnlyDispatcherCommands) return true;

        // For node path commands, check if the referenced script file exists
        return commands.every((h) => {
          const scriptPath = h.command ? extractHookScriptPath(h.command) : null;
          if (!scriptPath) return true; // not a path-based command
          return existsSync(scriptPath);
        });
      });

      const removed = entries.length - filtered.length;
      if (removed > 0) {
        hooks[hookType] = filtered;
        changes.push(`Removed ${removed} stale ${hookType} hook(s)`);
      }
    }

    // Register fresh hooks for required hook types
    const hookTypes: HookType[] = [
      HOOK_TYPES.PRE_TOOL_USE,
      HOOK_TYPES.SESSION_START,
    ];

    for (const hookType of hookTypes) {
      const command = buildHookCommand(hookType, pluginRoot);

      if (hookType === HOOK_TYPES.PRE_TOOL_USE) {
        const entry = {
          matcher: PRE_TOOL_USE_MATCHER_PATTERN,
          hooks: [{ type: "command", command }],
        };
        const existing = hooks.PreToolUse as Array<Record<string, unknown>> | undefined;
        if (existing && Array.isArray(existing)) {
          const idx = existing.findIndex((e) =>
            isContextModeHook(e as { hooks?: Array<{ command?: string }> }, hookType),
          );
          if (idx >= 0) {
            existing[idx] = entry;
            changes.push(`Updated existing ${hookType} hook entry`);
          } else {
            existing.push(entry);
            changes.push(`Added ${hookType} hook entry`);
          }
          hooks.PreToolUse = existing;
        } else {
          hooks.PreToolUse = [entry];
          changes.push(`Created ${hookType} hooks section`);
        }
      } else {
        const entry = {
          matcher: "",
          hooks: [{ type: "command", command }],
        };
        const existing = hooks[hookType] as Array<Record<string, unknown>> | undefined;
        if (existing && Array.isArray(existing)) {
          const idx = existing.findIndex((e) =>
            isContextModeHook(e as { hooks?: Array<{ command?: string }> }, hookType),
          );
          if (idx >= 0) {
            existing[idx] = entry;
            changes.push(`Updated existing ${hookType} hook entry`);
          } else {
            existing.push(entry);
            changes.push(`Added ${hookType} hook entry`);
          }
          hooks[hookType] = existing;
        } else {
          hooks[hookType] = [entry];
          changes.push(`Created ${hookType} hooks section`);
        }
      }
    }

    settings.hooks = hooks;
    this.writeSettings(settings);
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
    for (const [, scriptName] of Object.entries(HOOK_SCRIPTS)) {
      const scriptPath = resolve(pluginRoot, "hooks", scriptName);
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
    // Qwen Code has no plugin registry — no-op.
  }

  // ── Internal helpers ───────────────────────────────────

  /**
   * Extract session ID from Qwen Code hook input.
   * Priority: session_id field > QWEN_SESSION_ID env > ppid fallback.
   */
  private extractSessionId(input: QwenCodeHookInput): string {
    if (input.session_id) return input.session_id;
    if (process.env.QWEN_SESSION_ID) return process.env.QWEN_SESSION_ID;
    return `pid-${process.ppid}`;
  }
}
