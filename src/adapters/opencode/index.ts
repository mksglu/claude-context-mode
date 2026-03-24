/**
 * adapters/opencode — OpenCode platform adapter.
 *
 * Implements HookAdapter for OpenCode's TypeScript plugin paradigm.
 *
 * OpenCode hook specifics:
 *   - I/O: TS plugin functions (not JSON stdin/stdout)
 *   - Hook names: tool.execute.before, tool.execute.after, experimental.session.compacting
 *   - Arg modification: output.args mutation
 *   - Blocking: throw Error in tool.execute.before
 *   - Output modification: output.output mutation (TUI bug for bash #13575)
 *   - SessionStart: broken (#14808, no hook #5409)
 *   - Session ID: input.sessionID (camelCase!)
 *   - Project dir: ctx.directory in plugin init (no env var)
 *   - Config: opencode.json plugin array, .opencode/plugins/*.ts
 *   - Session dir: ~/.config/opencode/context-mode/sessions/
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
  RoutingInstructionsConfig,
} from "../types.js";

// ─────────────────────────────────────────────────────────
// OpenCode raw input types
// ─────────────────────────────────────────────────────────

/** Represents the combined input+output from OpenCode hooks, flattened for adapter parse methods. */
interface OpenCodeHookInput {
  /** From input.tool (both before and after hooks) */
  tool?: string;
  /** From input.sessionID */
  sessionID?: string;
  /** From input.callID */
  callID?: string;
  /** From output.args (before hook) or input.args (after hook) */
  args?: Record<string, unknown>;
  /** From output.output (after hook) */
  output?: string;
  /** From output.title (after hook) */
  title?: string;
  /** From output.metadata (after hook) */
  metadata?: unknown;
  /** For session start source (custom) */
  source?: string;
}

// ─────────────────────────────────────────────────────────
// Hook constants (re-exported from hooks.ts)
// ─────────────────────────────────────────────────────────

import { HOOK_TYPES as OPENCODE_HOOK_NAMES } from "./hooks.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class OpenCodeAdapter implements HookAdapter {
  readonly name = "OpenCode";
  readonly paradigm: HookParadigm = "ts-plugin";
  private settingsPath?: string;

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true, // experimental
    sessionStart: true,
    canModifyArgs: true,
    canModifyOutput: true, // with TUI bug caveat for bash (#13575)
    canInjectSessionContext: false,
  };

  // ── Input parsing ──────────────────────────────────────

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as OpenCodeHookInput;
    return {
      toolName: input.tool ?? "",
      toolInput: input.args ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: process.env.OPENCODE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as OpenCodeHookInput;
    return {
      toolName: input.tool ?? "",
      toolInput: input.args ?? {},
      toolOutput: input.output,
      isError: undefined, // OpenCode doesn't provide isError
      sessionId: this.extractSessionId(input),
      projectDir: process.env.OPENCODE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  parsePreCompactInput(raw: unknown): PreCompactEvent {
    const input = raw as OpenCodeHookInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: process.env.OPENCODE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as OpenCodeHookInput;
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
      projectDir: process.env.OPENCODE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  // ── Response formatting ────────────────────────────────

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    if (response.decision === "deny") {
      // OpenCode TS plugin paradigm: throw Error to block
      throw new Error(
        response.reason ?? "Blocked by context-mode hook",
      );
    }
    if (response.decision === "modify" && response.updatedInput) {
      // OpenCode: output.args mutation
      return { args: response.updatedInput };
    }
    if (response.decision === "ask") {
      // OpenCode: no native "ask" mechanism — throw to be safe
      throw new Error(
        response.reason ?? "Action requires user confirmation (security policy)",
      );
    }
    // "context" — OpenCode's tool.execute.before cannot inject additionalContext
    // in PreToolUse (platform limitation). The guidance is delivered via
    // CLAUDE.md/AGENTS.md routing instructions instead. Passthrough.
    // "allow" — passthrough
    return undefined;
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    const result: Record<string, unknown> = {};
    if (response.updatedOutput) {
      // OpenCode: output.output mutation (TUI bug for bash #13575)
      result.output = response.updatedOutput;
    }
    if (response.additionalContext) {
      result.additionalContext = response.additionalContext;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  formatPreCompactResponse(response: PreCompactResponse): unknown {
    // experimental.session.compacting — return context string
    return response.context ?? "";
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    return response.context ?? "";
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    return this.settingsPath ?? resolve("opencode.json");
  }

  private paths(): string[] {
    return [
      resolve("opencode.json"),
      resolve(".opencode", "opencode.json"),
      join(homedir(), ".config", "opencode", "opencode.json"),
    ];
  }

  getSessionDir(): string {
    const dir = join(homedir(), ".config", "opencode", "context-mode", "sessions");
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
    // OpenCode uses TS plugin paradigm — hooks are registered via plugin array
    // in opencode.json, not via command-based hook entries.
    // Return the hook name mapping for documentation purposes.
    return {
      [OPENCODE_HOOK_NAMES.BEFORE]: [
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
      [OPENCODE_HOOK_NAMES.AFTER]: [
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
      [OPENCODE_HOOK_NAMES.COMPACTING]: [
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
    this.settingsPath = undefined;
    for (const configPath of this.paths()) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        this.settingsPath = configPath;
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    return null;
  }

  writeSettings(settings: Record<string, unknown>): void {
    writeFileSync(
      this.getSettingsPath(),
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
        message: "Could not read opencode.json",
        fix: "context-mode upgrade",
      });
      return results;
    }

    // Check for "context-mode" in plugin array
    const plugins = settings.plugin as string[] | undefined;
    if (plugins && Array.isArray(plugins)) {
      const hasPlugin = plugins.some((p) => p.includes("context-mode"));
      results.push({
        check: "Plugin registration",
        status: hasPlugin ? "pass" : "fail",
        message: hasPlugin
          ? "context-mode found in plugin array"
          : "context-mode not found in plugin array",
        fix: hasPlugin
          ? undefined
          : "context-mode upgrade",
      });
    } else {
      results.push({
        check: "Plugin registration",
        status: "fail",
        message: "No plugin array found in opencode.json",
        fix: "context-mode upgrade",
      });
    }

    // Warn about SessionStart limitation
    results.push({
      check: "SessionStart hook",
      status: "warn",
      message:
        "SessionStart not supported in OpenCode (see issues #14808, #5409)",
    });

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    const settings = this.readSettings();
    if (!settings) {
      return {
        check: "Plugin registration",
        status: "warn",
        message: "Could not read opencode.json",
      };
    }

    const plugins = settings.plugin as string[] | undefined;
    if (plugins && Array.isArray(plugins)) {
      const hasPlugin = plugins.some((p) => p.includes("context-mode"));
      if (hasPlugin) {
        return {
          check: "Plugin registration",
          status: "pass",
          message: "context-mode found in plugin array",
        };
      }
    }

    return {
      check: "Plugin registration",
      status: "fail",
      message: "context-mode not found in opencode.json plugin array",
      fix: "context-mode upgrade",
    };
  }

  getInstalledVersion(): string {
    // Check ~/.cache/opencode/node_modules/ for context-mode
    try {
      const pkgPath = resolve(
        homedir(),
        ".cache",
        "opencode",
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

    // Add "context-mode" to the plugin array
    const plugins = (settings.plugin ?? []) as string[];
    if (!plugins.some((p) => p.includes("context-mode"))) {
      plugins.push("context-mode");
      changes.push("Added context-mode to plugin array");
    } else {
      changes.push("context-mode already in plugin array");
    }

    settings.plugin = plugins;
    this.writeSettings(settings);
    return changes;
  }

  backupSettings(): string | null {
    this.settingsPath = undefined;
    for (const configPath of this.paths()) {
      try {
        accessSync(configPath, constants.R_OK);
        this.settingsPath = configPath;
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
    // OpenCode uses TS plugin paradigm — no shell scripts to chmod
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // OpenCode manages plugins through npm/opencode.json — no separate registry
  }

  // ── Routing Instructions (soft enforcement) ────────────

  getRoutingInstructionsConfig(): RoutingInstructionsConfig {
    return {
      fileName: "AGENTS.md",
      globalPath: resolve(homedir(), ".config", "opencode", "AGENTS.md"),
      projectRelativePath: "AGENTS.md",
    };
  }

  writeRoutingInstructions(projectDir: string, pluginRoot: string): string | null {
    const config = this.getRoutingInstructionsConfig();
    const targetPath = resolve(projectDir, config.projectRelativePath);
    const sourcePath = resolve(pluginRoot, "configs", "opencode", config.fileName);

    try {
      const content = readFileSync(sourcePath, "utf-8");

      try {
        const existing = readFileSync(targetPath, "utf-8");
        if (existing.includes("context-mode")) return null;
        writeFileSync(targetPath, existing.trimEnd() + "\n\n" + content, "utf-8");
        return targetPath;
      } catch {
        writeFileSync(targetPath, content, "utf-8");
        return targetPath;
      }
    } catch {
      return null;
    }
  }

  // ── Internal helpers ───────────────────────────────────

  /**
   * Extract session ID from OpenCode hook input.
   * OpenCode uses camelCase sessionID.
   */
  private extractSessionId(input: OpenCodeHookInput): string {
    if (input.sessionID) return input.sessionID;
    return `pid-${process.ppid}`;
  }
}
