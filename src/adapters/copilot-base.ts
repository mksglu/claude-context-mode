/**
 * CopilotBaseAdapter — shared implementation for VS Code Copilot and JetBrains Copilot.
 *
 * Both platforms share the SAME Copilot agent runtime:
 *   - hookSpecificOutput wrapper with hookEventName
 *   - Same hook events (PreToolUse, PostToolUse, PreCompact, SessionStart)
 *   - Same .github/hooks/ config location
 *   - Same configureHooks logic
 *   - Same generateHookConfig format
 *   - Same parse/format methods
 *
 * Platform-specific differences handled by subclasses:
 *   - extractSessionId() — different env var fallbacks
 *   - getProjectDir() — different env vars for project root
 *   - getSessionDir() — different default session directories
 *   - checkPluginRegistration() — VS Code reads .vscode/mcp.json, JetBrains uses IDE UI
 *   - getInstalledVersion() — VS Code checks extensions dir, JetBrains checks hook config
 *   - validateHooks() — different warning messages
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  accessSync,
  chmodSync,
  constants,
} from "node:fs";
import { resolve, join } from "node:path";

import { BaseAdapter } from "./base.js";

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
} from "./types.js";

// ─────────────────────────────────────────────────────────
// Copilot raw input type (shared between VS Code & JetBrains)
// ─────────────────────────────────────────────────────────

export interface CopilotHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  is_error?: boolean;
  /** Copilot uses camelCase sessionId (NOT session_id). */
  sessionId?: string;
  source?: string;
}

// ─────────────────────────────────────────────────────────
// Hook module interface — each platform re-exports from its hooks.ts
// ─────────────────────────────────────────────────────────

export interface CopilotHookModule {
  HOOK_TYPES: {
    readonly PRE_TOOL_USE: string;
    readonly POST_TOOL_USE: string;
    readonly PRE_COMPACT: string;
    readonly SESSION_START: string;
    // Optional — vscode-copilot dropped these (no scripts present, samples
    // confirm not blocking). Other Copilot platforms (e.g. jetbrains) may
    // still surface them as orphan declarations until their script set lands.
    readonly STOP?: string;
    readonly SUBAGENT_START?: string;
    readonly SUBAGENT_STOP?: string;
  };
  HOOK_SCRIPTS: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildHookCommand: (hookType: any, pluginRoot?: string) => string;
}

// ─────────────────────────────────────────────────────────
// Abstract base adapter for Copilot platforms
// ─────────────────────────────────────────────────────────

export abstract class CopilotBaseAdapter extends BaseAdapter implements HookAdapter {
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

  /** Subclasses must provide their platform name. */
  abstract readonly name: string;

  /** Subclasses must provide their hook module (HOOK_TYPES, HOOK_SCRIPTS, buildHookCommand). */
  protected abstract readonly hookModule: CopilotHookModule;

  /** Subclasses must provide the hook scripts subdirectory name (e.g., "vscode-copilot"). */
  protected abstract readonly hookSubdir: string;

  // ── Platform-specific abstract methods ─────────────────

  /** Extract session ID from Copilot hook input — env var fallbacks differ per platform. */
  protected abstract extractSessionId(input: CopilotHookInput): string;

  /** Get the project directory — env vars differ per platform. */
  protected abstract getProjectDir(): string;

  // ── Diagnostics — platform-specific (abstract) ─────────

  /** Validate that hooks are properly configured for this platform. */
  abstract validateHooks(pluginRoot: string): DiagnosticResult[];

  /** Check if the plugin is registered/enabled on this platform. */
  abstract checkPluginRegistration(): DiagnosticResult;

  /** Get the installed version from this platform's registry/marketplace. */
  abstract getInstalledVersion(): string;

  // ── Input parsing (shared) ─────────────────────────────

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as CopilotHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as CopilotHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      toolOutput: input.tool_output,
      isError: input.is_error,
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(),
      raw,
    };
  }

  parsePreCompactInput(raw: unknown): PreCompactEvent {
    const input = raw as CopilotHookInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as CopilotHookInput;
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
      projectDir: this.getProjectDir(),
      raw,
    };
  }

  // ── Response formatting (shared) ───────────────────────

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    if (response.decision === "deny") {
      return {
        permissionDecision: "deny",
        reason: response.reason ?? "Blocked by context-mode hook",
      };
    }
    if (response.decision === "modify" && response.updatedInput) {
      return {
        hookSpecificOutput: {
          hookEventName: this.hookModule.HOOK_TYPES.PRE_TOOL_USE,
          updatedInput: response.updatedInput,
        },
      };
    }
    if (response.decision === "context" && response.additionalContext) {
      return {
        hookSpecificOutput: {
          hookEventName: this.hookModule.HOOK_TYPES.PRE_TOOL_USE,
          additionalContext: response.additionalContext,
        },
      };
    }
    if (response.decision === "ask") {
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
      return {
        hookSpecificOutput: {
          hookEventName: this.hookModule.HOOK_TYPES.POST_TOOL_USE,
          decision: "block",
          reason: response.updatedOutput,
        },
      };
    }
    if (response.additionalContext) {
      return {
        hookSpecificOutput: {
          hookEventName: this.hookModule.HOOK_TYPES.POST_TOOL_USE,
          additionalContext: response.additionalContext,
        },
      };
    }
    return undefined;
  }

  formatPreCompactResponse(response: PreCompactResponse): unknown {
    return response.context ?? "";
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    return response.context ?? "";
  }

  // ── Configuration (shared) ─────────────────────────────

  /**
   * Resolve the absolute path to the Copilot-style hook settings file.
   *
   * Issue #539 fix: previously this returned `resolve(".github", ...)`
   * — a CWD-relative path. `doctor` (validateHooks) and `upgrade`
   * (configureAllHooks) could legitimately run from different working
   * directories (CLI invoked from a subdir, MCP server cwd=projectDir),
   * so each saw a DIFFERENT settings path and the diagnose/repair loop
   * never converged on the same file.
   *
   * Now anchors on `projectDir` when supplied (matching the sibling
   * `getConfigDir(projectDir?: string)` signature in
   * vscode-copilot/index.ts:93). Falls back to `process.cwd()` to keep
   * existing callers source-compatible — the slice-5 follow-up will
   * thread projectDir through `cli.ts doctor`/`upgrade`.
   */
  getSettingsPath(projectDir?: string): string {
    return resolve(projectDir ?? process.cwd(), ".github", "hooks", "context-mode.json");
  }

  generateHookConfig(pluginRoot: string): HookRegistration {
    const { HOOK_TYPES, buildHookCommand } = this.hookModule;
    return {
      [HOOK_TYPES.PRE_TOOL_USE]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildHookCommand(HOOK_TYPES.PRE_TOOL_USE, pluginRoot),
            },
          ],
        },
      ],
      [HOOK_TYPES.POST_TOOL_USE]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildHookCommand(HOOK_TYPES.POST_TOOL_USE, pluginRoot),
            },
          ],
        },
      ],
      [HOOK_TYPES.PRE_COMPACT]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildHookCommand(HOOK_TYPES.PRE_COMPACT, pluginRoot),
            },
          ],
        },
      ],
      [HOOK_TYPES.SESSION_START]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildHookCommand(HOOK_TYPES.SESSION_START, pluginRoot),
            },
          ],
        },
      ],
    };
  }

  readSettings(): Record<string, unknown> | null {
    // Primary: .github/hooks/context-mode.json
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
    // Fallback: .claude/settings.json
    try {
      const raw = readFileSync(resolve(".claude", "settings.json"), "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  writeSettings(settings: Record<string, unknown>): void {
    const configPath = this.getSettingsPath();
    mkdirSync(resolve(".github", "hooks"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(settings, null, 2) + "\n",
      "utf-8",
    );
  }

  // ── Upgrade (shared) ──────────────────────────────────

  configureAllHooks(pluginRoot: string): string[] {
    const changes: string[] = [];
    const settings = this.readSettings() ?? {};
    const hooks = (settings.hooks as Record<string, unknown> | undefined) ?? {};

    const { HOOK_TYPES, HOOK_SCRIPTS, buildHookCommand } = this.hookModule;

    const hookTypes = [
      HOOK_TYPES.PRE_TOOL_USE,
      HOOK_TYPES.POST_TOOL_USE,
      HOOK_TYPES.PRE_COMPACT,
      HOOK_TYPES.SESSION_START,
    ];

    for (const hookType of hookTypes) {
      const script = HOOK_SCRIPTS[hookType];
      if (!script) continue;

      hooks[hookType] = [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildHookCommand(hookType, pluginRoot),
            },
          ],
        },
      ];
      changes.push(`Configured ${hookType} hook`);
    }

    settings.hooks = hooks;
    this.writeSettings(settings);
    changes.push(`Wrote hook config to ${this.getSettingsPath()}`);

    return changes;
  }

  setHookPermissions(pluginRoot: string): string[] {
    const set: string[] = [];
    const hooksDir = join(pluginRoot, "hooks", this.hookSubdir);
    for (const scriptName of Object.values(this.hookModule.HOOK_SCRIPTS)) {
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
    // Copilot platforms manage plugins through their own marketplaces.
    // No manual registry update needed.
  }
}
