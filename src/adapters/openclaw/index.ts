/**
 * adapters/openclaw — OpenClaw platform adapter.
 *
 * Implements HookAdapter for OpenClaw's TypeScript plugin paradigm.
 *
 * OpenClaw hook specifics:
 *   - I/O: TS plugin functions via api.registerHook() and api.on()
 *   - Hook events: tool_call:before, tool_call:after, command:new
 *   - Lifecycle: before_prompt_build (routing instruction injection)
 *   - Context engine: api.registerContextEngine() with ownsCompaction
 *   - Arg modification: mutate event.params in tool_call:before
 *   - Blocking: return { block: true, blockReason } from tool_call:before
 *   - Session ID: event context (no specific env var)
 *   - Project dir: process.cwd()
 *   - Config: openclaw.json plugins.entries, ~/.openclaw/extensions/
 *   - Session dir: ~/.openclaw/context-mode/sessions/
 */

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  accessSync,
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
// OpenClaw raw input types
// ─────────────────────────────────────────────────────────

interface OpenClawHookInput {
  toolName?: string;
  tool_name?: string;
  params?: Record<string, unknown>;
  tool_input?: Record<string, unknown>;
  output?: string;
  tool_output?: string;
  isError?: boolean;
  is_error?: boolean;
  sessionId?: string;
  source?: string;
}

// ─────────────────────────────────────────────────────────
// Hook constants (re-exported from hooks.ts)
// ─────────────────────────────────────────────────────────

import { HOOK_EVENTS as OPENCLAW_HOOK_EVENTS } from "./hooks.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class OpenClawAdapter implements HookAdapter {
  readonly name = "OpenClaw";
  readonly paradigm: HookParadigm = "ts-plugin";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true, // via registerContextEngine with ownsCompaction
    sessionStart: true, // via command:new hook
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true, // via before_prompt_build lifecycle hook
  };

  // ── Input parsing ──────────────────────────────────────

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as OpenClawHookInput;
    return {
      toolName: input.toolName ?? input.tool_name ?? "",
      toolInput: input.params ?? input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: process.cwd(),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as OpenClawHookInput;
    return {
      toolName: input.toolName ?? input.tool_name ?? "",
      toolInput: input.params ?? input.tool_input ?? {},
      toolOutput: input.output ?? input.tool_output,
      isError: input.isError ?? input.is_error,
      sessionId: this.extractSessionId(input),
      projectDir: process.cwd(),
      raw,
    };
  }

  parsePreCompactInput(raw: unknown): PreCompactEvent {
    const input = raw as OpenClawHookInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: process.cwd(),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as OpenClawHookInput;
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
      projectDir: process.cwd(),
      raw,
    };
  }

  // ── Response formatting ────────────────────────────────

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    if (response.decision === "deny") {
      // OpenClaw plugin paradigm: return { block, blockReason } to block
      return {
        block: true,
        blockReason: response.reason ?? "Blocked by context-mode hook",
      };
    }
    if (response.decision === "modify" && response.updatedInput) {
      // OpenClaw: mutate params in the event object
      return { params: response.updatedInput };
    }
    if (response.decision === "ask") {
      // OpenClaw: block for safety when user confirmation needed
      return {
        block: true,
        blockReason: response.reason ?? "Action requires user confirmation (security policy)",
      };
    }
    if (response.decision === "context" && response.additionalContext) {
      // OpenClaw supports context injection via before_prompt_build,
      // but not inline in tool_call:before. Passthrough.
      return undefined;
    }
    // "allow" — passthrough
    return undefined;
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    const result: Record<string, unknown> = {};
    if (response.additionalContext) {
      result.additionalContext = response.additionalContext;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  formatPreCompactResponse(response: PreCompactResponse): unknown {
    // Context engine compact() returns { ok, compacted } — context is managed internally
    return response.context ?? "";
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    return response.context ?? "";
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    // OpenClaw uses openclaw.json in the project root or ~/.openclaw/openclaw.json
    return resolve("openclaw.json");
  }

  getSessionDir(): string {
    const dir = join(homedir(), ".openclaw", "context-mode", "sessions");
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

  generateHookConfig(_pluginRoot: string): HookRegistration {
    // OpenClaw uses TS plugin paradigm — hooks are registered via
    // api.registerHook() in the plugin entry point, not via config files.
    // Return the hook name mapping for documentation purposes.
    return {
      [OPENCLAW_HOOK_EVENTS.TOOL_CALL_BEFORE]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "context-mode",
            },
          ],
        },
      ],
      [OPENCLAW_HOOK_EVENTS.TOOL_CALL_AFTER]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "context-mode",
            },
          ],
        },
      ],
      [OPENCLAW_HOOK_EVENTS.COMMAND_NEW]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "context-mode",
            },
          ],
        },
      ],
    };
  }

  readSettings(): Record<string, unknown> | null {
    // Try project-local paths first, then global config
    const paths = [
      resolve("openclaw.json"),
      resolve(".openclaw", "openclaw.json"),
      join(homedir(), ".openclaw", "openclaw.json"),
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
    // Write to openclaw.json in current directory
    const configPath = resolve("openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify(settings, null, 2) + "\n",
      "utf-8",
    );
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const settings = this.readSettings();

    if (!settings) {
      results.push({
        check: "Plugin configuration",
        status: "fail",
        message: "Could not read openclaw.json",
        fix: "context-mode upgrade",
      });
      return results;
    }

    // Check for context-mode in plugins.entries
    const plugins = settings.plugins as Record<string, unknown> | undefined;
    const entries = plugins?.entries as Record<string, unknown> | undefined;

    if (entries) {
      const hasPlugin = Object.keys(entries).some((k) => k.includes("context-mode"));
      results.push({
        check: "Plugin registration",
        status: hasPlugin ? "pass" : "fail",
        message: hasPlugin
          ? "context-mode found in plugins.entries"
          : "context-mode not found in plugins.entries",
        fix: hasPlugin
          ? undefined
          : "context-mode upgrade",
      });

      // Check if enabled
      if (hasPlugin) {
        const entry = entries["context-mode"] as Record<string, unknown> | undefined;
        const isEnabled = entry?.enabled !== false;
        results.push({
          check: "Plugin enabled",
          status: isEnabled ? "pass" : "warn",
          message: isEnabled
            ? "context-mode plugin is enabled"
            : "context-mode plugin is disabled",
        });
      }
    } else {
      results.push({
        check: "Plugin registration",
        status: "fail",
        message: "No plugins.entries found in openclaw.json",
        fix: "context-mode upgrade",
      });
    }

    // Check context engine slot
    const slots = plugins?.slots as Record<string, unknown> | undefined;
    if (slots?.contextEngine === "context-mode") {
      results.push({
        check: "Context engine",
        status: "pass",
        message: "context-mode registered as context engine (owns compaction)",
      });
    } else {
      results.push({
        check: "Context engine",
        status: "warn",
        message:
          "context-mode not set as context engine — compaction will use default engine",
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
        message: "Could not read openclaw.json",
      };
    }

    const plugins = settings.plugins as Record<string, unknown> | undefined;
    const entries = plugins?.entries as Record<string, unknown> | undefined;

    if (entries) {
      const hasPlugin = Object.keys(entries).some((k) => k.includes("context-mode"));
      if (hasPlugin) {
        return {
          check: "Plugin registration",
          status: "pass",
          message: "context-mode found in plugins.entries",
        };
      }
    }

    return {
      check: "Plugin registration",
      status: "fail",
      message: "context-mode not found in openclaw.json plugins.entries",
      fix: "context-mode upgrade",
    };
  }

  getInstalledVersion(): string {
    // Check ~/.openclaw/extensions/context-mode/ for the plugin
    try {
      const pkgPath = resolve(
        homedir(),
        ".openclaw",
        "extensions",
        "context-mode",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* not found */
    }

    // Also check node_modules
    try {
      const pkgPath = resolve(
        "node_modules",
        "context-mode",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* not found */
    }

    return "not installed";
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(_pluginRoot: string): string[] {
    const settings = this.readSettings() ?? {};
    const changes: string[] = [];

    // Ensure plugins.entries exists
    if (!settings.plugins) {
      settings.plugins = {};
    }
    const plugins = settings.plugins as Record<string, unknown>;

    if (!plugins.entries) {
      plugins.entries = {};
    }
    const entries = plugins.entries as Record<string, unknown>;

    // Add context-mode to plugins.entries
    if (!entries["context-mode"]) {
      entries["context-mode"] = { enabled: true };
      changes.push("Added context-mode to plugins.entries");
    } else {
      const entry = entries["context-mode"] as Record<string, unknown>;
      if (entry.enabled === false) {
        entry.enabled = true;
        changes.push("Enabled context-mode plugin");
      } else {
        changes.push("context-mode already configured in plugins.entries");
      }
    }

    // Optionally set context engine slot
    if (!plugins.slots) {
      plugins.slots = {};
    }
    const slots = plugins.slots as Record<string, unknown>;
    if (!slots.contextEngine) {
      slots.contextEngine = "context-mode";
      changes.push("Set context-mode as context engine (owns compaction)");
    } else if (slots.contextEngine !== "context-mode") {
      changes.push(
        `Context engine already set to "${slots.contextEngine}" — not overwriting`,
      );
    }

    this.writeSettings(settings);
    return changes;
  }

  backupSettings(): string | null {
    const paths = [
      resolve("openclaw.json"),
      resolve(".openclaw", "openclaw.json"),
      join(homedir(), ".openclaw", "openclaw.json"),
    ];
    for (const configPath of paths) {
      try {
        accessSync(configPath, constants.R_OK);
        const backupPath = configPath + ".bak";
        copyFileSync(configPath, backupPath);
        return backupPath;
      } catch {
        continue;
      }
    }
    return null;
  }

  setHookPermissions(_pluginRoot: string): string[] {
    // OpenClaw uses TS plugin paradigm — no shell scripts to chmod
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // OpenClaw manages plugins through npm/openclaw.json — no separate registry
  }

  // ── Internal helpers ───────────────────────────────────

  /**
   * Extract session ID from OpenClaw hook input.
   */
  private extractSessionId(input: OpenClawHookInput): string {
    if (input.sessionId) return input.sessionId;
    return `pid-${process.ppid}`;
  }
}
