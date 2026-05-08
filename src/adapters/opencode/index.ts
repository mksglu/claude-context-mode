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

/** Strip JSONC comments (// and /* *​/) and trailing commas for JSON.parse. */
function stripJsonComments(str: string): string {
  return str
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,(\s*[}\]])/g, "$1");
}
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

import { BaseAdapter } from "../base.js";

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
  PlatformId,
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

export type AdapterPlatformType = Extract<PlatformId, "opencode" | "kilo">;

export class OpenCodeAdapter extends BaseAdapter implements HookAdapter {
  get name(): string {
    return this.platform === "kilo" ? "KiloCode" : "OpenCode";
  }
  readonly paradigm: HookParadigm = "ts-plugin";
  private settingsPath?: string;

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true, // experimental
    sessionStart: true,
    canModifyArgs: true,
    canModifyOutput: true, // with TUI bug caveat for bash (#13575)
    canInjectSessionContext: true,
  };

  private platform: AdapterPlatformType;

  constructor(platform: AdapterPlatformType = "opencode") {
    // sessionDirSegments unused — opencode overrides getSessionDir()
    // with XDG_CONFIG_HOME / APPDATA logic
    super([".config", platform]);
    this.platform = platform;
  }

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
    // OpenCode uses opencode.json in the project root or .opencode/opencode.json
    return this.settingsPath ?? resolve(`${this.platform}.json`);
  }

  private paths(): string[] {
    if (this.platform === "kilo") {
      // Kilo runtime accepts `.kilo/`, `.kilocode/`, and `.opencode/` as
      // project config dirs (refs/platforms/kilo/packages/opencode/src/
      // kilocode/config/config.ts:50,408). Mirror that here so context-mode
      // discovers config regardless of which suffix the user adopted.
      return [
        resolve("kilo.json"),
        resolve("kilo.jsonc"),
        resolve(".kilo", "kilo.json"),
        resolve(".kilo", "kilo.jsonc"),
        resolve(".kilocode", "kilo.json"),
        resolve(".kilocode", "kilo.jsonc"),
        join(homedir(), ".config", "kilo", "kilo.json"),
        join(homedir(), ".config", "kilo", "kilo.jsonc"),
      ];
    }
    return [
      resolve("opencode.json"),
      resolve("opencode.jsonc"),
      resolve(".opencode", "opencode.json"),
      resolve(".opencode", "opencode.jsonc"),
      join(homedir(), ".config", "opencode", "opencode.json"),
      join(homedir(), ".config", "opencode", "opencode.jsonc"),
    ];
  }

  getSessionDir(): string {
    const dir = join(this.getConfigDir(), "context-mode", "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * OpenCode/KiloCode honor XDG_CONFIG_HOME on POSIX and APPDATA on Windows.
   * Falls back to ~/.config/<platform> (or %APPDATA%\<platform>).
   * Always absolute. `_projectDir` is accepted for interface symmetry but
   * unused — config is home/XDG-rooted, never project-scoped.
   */
  getConfigDir(_projectDir?: string): string {
    let root: string;
    if (process.platform === "win32") {
      root = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    } else {
      root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    }
    return join(root, this.platform);
  }

  getInstructionFiles(): string[] {
    return ["AGENTS.md"];
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
    const configPaths = this.paths();
    const globalPaths = new Set(configPaths.filter(p => p.includes(homedir())));
    let firstValidSettings: Record<string, unknown> | null = null;
    let firstValidPath: string | undefined;

    for (const configPath of configPaths) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const text = configPath.endsWith(".jsonc") ? stripJsonComments(raw) : raw;
        const settings = JSON.parse(text) as Record<string, unknown>;

        if (!firstValidSettings) {
          firstValidSettings = settings;
          firstValidPath = configPath;
        }

        const isGlobalConfig = globalPaths.has(configPath);

        if (this.hasContextModePlugin(settings) || isGlobalConfig) {
          this.settingsPath = configPath;
          return settings;
        }
      } catch {
        continue;
      }
    }

    if (firstValidSettings) {
      this.settingsPath = firstValidPath;
      return firstValidSettings;
    }
    return null;
  }

  writeSettings(settings: Record<string, unknown>): void {
    // Write to opencode.json(c)/kilo.json(c) in current directory
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
        message: `Could not read ${this.platform}.json or ${this.platform}.jsonc`,
        fix: "context-mode upgrade",
      });
      return results;
    }

    // Check for "context-mode" in plugin array
    const hasPlugin = this.hasContextModePlugin(settings);
    if (Array.isArray(settings.plugin)) {
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
        message: `No plugin array found in ${this.platform}.json or ${this.platform}.jsonc`,
        fix: "context-mode upgrade",
      });
    }

    // Note: SessionStart handled via experimental.chat.system.transform surrogate
    results.push({
      check: "SessionStart hook",
      status: "pass",
      message:
        `SessionStart via experimental.chat.system.transform surrogate (native hook pending #14808, #5409)`,
    });

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    const settings = this.readSettings();
    if (!settings) {
      return {
        check: "Plugin registration",
        status: "warn",
        message: `Could not read ${this.platform}.json or ${this.platform}.jsonc`,
      };
    }

    if (this.hasContextModePlugin(settings)) {
      return {
        check: "Plugin registration",
        status: "pass",
        message: "context-mode found in plugin array",
      };
    }

    return {
      check: "Plugin registration",
      status: "fail",
      message: `context-mode not found in ${this.platform}.json plugin array`,
      fix: "context-mode upgrade",
    };
  }

  getInstalledVersion(): string {
    // Check ~/.cache/opencode/node_modules/ for context-mode
    try {
      const pkgPath = resolve(
        homedir(),
        ".cache",
        this.platform,
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
    const check = this.checkPluginRegistration();
    
    if (!this.settingsPath) return null;

    if (check.status === "pass") {
      return this.settingsPath;
    } else {
      try {
        accessSync(this.settingsPath, constants.R_OK);
        const backupPath = this.settingsPath + ".bak";
        copyFileSync(this.settingsPath, backupPath);
        return backupPath;
      } catch { 
        return null;
       }
    }
  }

  setHookPermissions(_pluginRoot: string): string[] {
    // OpenCode uses TS plugin paradigm — no shell scripts to chmod
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // OpenCode manages plugins through npm/opencode.json — no separate registry
  }

  // ── Internal helpers ───────────────────────────────────

  /**
   * Check whether a settings object has the context-mode plugin registered.
   */
  private hasContextModePlugin(settings: Record<string, unknown>): boolean {
    const plugins = settings.plugin;
    return Array.isArray(plugins) && plugins.some((p: unknown) => typeof p === "string" && p.includes("context-mode"));
  }

  /**
   * Extract session ID from OpenCode hook input.
   * OpenCode uses camelCase sessionID.
   */
  private extractSessionId(input: OpenCodeHookInput): string {
    if (input.sessionID) return input.sessionID;
    return `pid-${process.ppid}`;
  }
}
