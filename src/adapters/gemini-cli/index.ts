/**
 * adapters/gemini-cli — Gemini CLI platform adapter.
 *
 * Implements HookAdapter for Gemini CLI's JSON stdin/stdout hook paradigm.
 *
 * Gemini CLI hook specifics:
 *   - I/O: JSON on stdin, JSON on stdout (same paradigm as Claude Code)
 *   - Hook names: BeforeTool, AfterTool, PreCompress, SessionStart
 *   - Arg modification: `hookSpecificOutput.tool_input` (merged with original)
 *   - Blocking: `decision: "deny"` in response (NOT permissionDecision)
 *   - Output modification: `decision: "deny"` + reason replaces output,
 *     `hookSpecificOutput.additionalContext` appends
 *   - PreCompress: advisory only (async, cannot block)
 *   - No `decision: "ask"` support
 *   - Hooks don't fire for subagents yet
 *   - Config: ~/.gemini/settings.json (user), .gemini/settings.json (project)
 *   - Session ID: session_id field
 *   - Project dir env: GEMINI_PROJECT_DIR (also CLAUDE_PROJECT_DIR alias)
 *   - Session dir: ~/.gemini/context-mode/sessions/
 */

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  accessSync,
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
// Gemini CLI raw input types
// ─────────────────────────────────────────────────────────

interface GeminiCLIHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  is_error?: boolean;
  session_id?: string;
  source?: string;
}

// ─────────────────────────────────────────────────────────
// Hook constants (re-exported from hooks.ts)
// ─────────────────────────────────────────────────────────

import {
  HOOK_TYPES as GEMINI_HOOK_NAMES,
  HOOK_SCRIPTS as GEMINI_HOOK_SCRIPTS,
  buildHookCommand as buildGeminiHookCommand,
  type HookType as GeminiHookType,
} from "./hooks.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class GeminiCLIAdapter implements HookAdapter {
  readonly name = "Gemini CLI";
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
    const input = raw as GeminiCLIHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as GeminiCLIHookInput;
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
    const input = raw as GeminiCLIHookInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as GeminiCLIHookInput;
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

  // ── Response formatting ────────────────────────────────

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    if (response.decision === "deny") {
      return {
        decision: "deny",
        reason: response.reason ?? "Blocked by context-mode hook",
      };
    }
    if (response.decision === "modify" && response.updatedInput) {
      return {
        hookSpecificOutput: {
          tool_input: response.updatedInput,
        },
      };
    }
    if (response.decision === "context" && response.additionalContext) {
      // Gemini CLI: inject additionalContext via hookSpecificOutput
      return {
        hookSpecificOutput: {
          additionalContext: response.additionalContext,
        },
      };
    }
    if (response.decision === "ask") {
      // Gemini CLI: no native "ask" — deny to be safe
      return {
        decision: "deny",
        reason: response.reason ?? "Action requires user confirmation (security policy)",
      };
    }
    // "allow" — return undefined for passthrough
    return undefined;
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    if (response.updatedOutput) {
      // Gemini CLI: decision "deny" + reason replaces output
      return {
        decision: "deny",
        reason: response.updatedOutput,
      };
    }
    if (response.additionalContext) {
      return {
        hookSpecificOutput: {
          additionalContext: response.additionalContext,
        },
      };
    }
    return undefined;
  }

  formatPreCompactResponse(response: PreCompactResponse): unknown {
    // PreCompress is advisory only (async), but we can still return context
    return response.context ?? "";
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    return response.context ?? "";
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    return resolve(homedir(), ".gemini", "settings.json");
  }

  getSessionDir(): string {
    const dir = join(homedir(), ".gemini", "context-mode", "sessions");
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
      [GEMINI_HOOK_NAMES.BEFORE_TOOL]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildGeminiHookCommand(GEMINI_HOOK_NAMES.BEFORE_TOOL, pluginRoot),
            },
          ],
        },
      ],
      [GEMINI_HOOK_NAMES.AFTER_TOOL]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildGeminiHookCommand(GEMINI_HOOK_NAMES.AFTER_TOOL, pluginRoot),
            },
          ],
        },
      ],
      [GEMINI_HOOK_NAMES.PRE_COMPRESS]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildGeminiHookCommand(GEMINI_HOOK_NAMES.PRE_COMPRESS, pluginRoot),
            },
          ],
        },
      ],
      [GEMINI_HOOK_NAMES.SESSION_START]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildGeminiHookCommand(GEMINI_HOOK_NAMES.SESSION_START, pluginRoot),
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
    const dir = resolve(homedir(), ".gemini");
    mkdirSync(dir, { recursive: true });
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
        check: "BeforeTool hook",
        status: "fail",
        message: "Could not read ~/.gemini/settings.json",
        fix: "context-mode upgrade",
      });
      return results;
    }

    const hooks = settings.hooks as Record<string, unknown[]> | undefined;

    // Check BeforeTool
    const beforeTool = hooks?.[GEMINI_HOOK_NAMES.BEFORE_TOOL] as
      | Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
      | undefined;
    if (beforeTool && beforeTool.length > 0) {
      const hasHook = beforeTool.some((entry) =>
        entry.hooks?.some((h) => h.command?.includes("context-mode")),
      );
      results.push({
        check: "BeforeTool hook",
        status: hasHook ? "pass" : "fail",
        message: hasHook
          ? "BeforeTool hook configured"
          : "BeforeTool exists but does not point to context-mode",
        fix: hasHook ? undefined : "context-mode upgrade",
      });
    } else {
      results.push({
        check: "BeforeTool hook",
        status: "fail",
        message: "No BeforeTool hooks found",
        fix: "context-mode upgrade",
      });
    }

    // Check SessionStart
    const sessionStart = hooks?.[GEMINI_HOOK_NAMES.SESSION_START] as
      | Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
      | undefined;
    if (sessionStart && sessionStart.length > 0) {
      const hasHook = sessionStart.some((entry) =>
        entry.hooks?.some((h) => h.command?.includes("context-mode")),
      );
      results.push({
        check: "SessionStart hook",
        status: hasHook ? "pass" : "fail",
        message: hasHook
          ? "SessionStart hook configured"
          : "SessionStart exists but does not point to context-mode",
        fix: hasHook ? undefined : "context-mode upgrade",
      });
    } else {
      results.push({
        check: "SessionStart hook",
        status: "fail",
        message: "No SessionStart hooks found",
        fix: "context-mode upgrade",
      });
    }

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    const settings = this.readSettings();
    if (!settings) {
      return {
        check: "Plugin registration",
        status: "warn",
        message: "Could not read ~/.gemini/settings.json",
      };
    }

    // Check in extensions or settings for context-mode
    const extensions = settings.extensions as
      | Record<string, unknown>
      | Array<unknown>
      | undefined;

    if (extensions) {
      const hasPlugin = Array.isArray(extensions)
        ? extensions.some(
            (e) =>
              typeof e === "string" && e.includes("context-mode"),
          )
        : Object.keys(extensions).some((k) => k.includes("context-mode"));

      if (hasPlugin) {
        return {
          check: "Plugin registration",
          status: "pass",
          message: "context-mode found in extensions",
        };
      }
    }

    return {
      check: "Plugin registration",
      status: "warn",
      message: "context-mode not found in extensions (might be using standalone MCP mode)",
    };
  }

  getInstalledVersion(): string {
    // Check ~/.gemini/ extension cache for context-mode
    try {
      const cachePath = resolve(
        homedir(),
        ".gemini",
        "extensions",
        "context-mode",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(cachePath, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* not found */
    }
    return "not installed";
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(pluginRoot: string): string[] {
    const settings = this.readSettings() ?? {};
    const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
    const changes: string[] = [];

    const hookConfigs: Array<{
      name: string;
    }> = [
      { name: GEMINI_HOOK_NAMES.BEFORE_TOOL },
      { name: GEMINI_HOOK_NAMES.SESSION_START },
    ];

    for (const config of hookConfigs) {
      const command = buildGeminiHookCommand(config.name as GeminiHookType, pluginRoot);
      const entry = {
        matcher: "",
        hooks: [{ type: "command", command }],
      };

      const existing = hooks[config.name] as
        | Array<Record<string, unknown>>
        | undefined;
      if (existing && Array.isArray(existing)) {
        const idx = existing.findIndex((e) => {
          const entryHooks = e.hooks as Array<{ command?: string }> | undefined;
          return entryHooks?.some((h) => h.command?.includes("context-mode"));
        });
        if (idx >= 0) {
          existing[idx] = entry;
          changes.push(`Updated existing ${config.name} hook entry`);
        } else {
          existing.push(entry);
          changes.push(`Added ${config.name} hook entry`);
        }
        hooks[config.name] = existing;
      } else {
        hooks[config.name] = [entry];
        changes.push(`Created ${config.name} hooks section`);
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
    const hooksDir = join(pluginRoot, "hooks", "gemini-cli");
    for (const scriptName of Object.values(GEMINI_HOOK_SCRIPTS)) {
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

  updatePluginRegistry(pluginRoot: string, version: string): void {
    // Gemini CLI doesn't have a formal plugin registry like Claude Code.
    // Update the extension cache package.json if it exists.
    try {
      const pkgPath = resolve(
        homedir(),
        ".gemini",
        "extensions",
        "context-mode",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      pkg.version = version;
      pkg.installPath = pluginRoot;
      pkg.lastUpdated = new Date().toISOString();
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
    } catch {
      /* best effort */
    }
  }

  // ── Internal helpers ───────────────────────────────────

  /** Get the project directory from environment variables. */
  private getProjectDir(): string | undefined {
    return process.env.GEMINI_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR;
  }

  /**
   * Extract session ID from Gemini CLI hook input.
   * Priority: session_id field > env fallback > ppid fallback.
   */
  private extractSessionId(input: GeminiCLIHookInput): string {
    if (input.session_id) return input.session_id;
    return `pid-${process.ppid}`;
  }
}
