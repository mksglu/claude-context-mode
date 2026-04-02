/**
 * adapters/claude-code — Claude Code platform adapter.
 *
 * Implements HookAdapter for Claude Code's JSON stdin/stdout hook paradigm.
 *
 * Claude Code hook specifics:
 *   - I/O: JSON on stdin, JSON on stdout
 *   - Arg modification: `updatedInput` field in response
 *   - Blocking: `permissionDecision: "deny"` in response
 *   - PostToolUse output: `updatedMCPToolOutput` field
 *   - PreCompact: stdout on exit 0
 *   - Session ID: transcript_path UUID > session_id > CLAUDE_SESSION_ID > ppid
 *   - Config: ~/.claude/settings.json
 *   - Session dir: ~/.claude/context-mode/sessions/
 */

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  accessSync,
  existsSync,
  readdirSync,
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
// Claude Code raw input types
// ─────────────────────────────────────────────────────────

interface ClaudeCodeHookInput {
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

export class ClaudeCodeAdapter implements HookAdapter {
  readonly name = "Claude Code";
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
    const input = raw as ClaudeCodeHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: process.env.CLAUDE_PROJECT_DIR,
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as ClaudeCodeHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      toolOutput: input.tool_output,
      isError: input.is_error,
      sessionId: this.extractSessionId(input),
      projectDir: process.env.CLAUDE_PROJECT_DIR,
      raw,
    };
  }

  parsePreCompactInput(raw: unknown): PreCompactEvent {
    const input = raw as ClaudeCodeHookInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: process.env.CLAUDE_PROJECT_DIR,
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as ClaudeCodeHookInput;
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
      projectDir: process.env.CLAUDE_PROJECT_DIR,
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
      // Claude Code: inject additionalContext into model context
      return { additionalContext: response.additionalContext };
    }
    if (response.decision === "ask") {
      // Claude Code: native "ask" — prompt user for permission
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
    // Claude Code: stdout content on exit 0 is injected as context
    return response.context ?? "";
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    // Claude Code: stdout content is injected as additional context
    return response.context ?? "";
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    return resolve(homedir(), ".claude", "settings.json");
  }

  getSessionDir(): string {
    const dir = join(homedir(), ".claude", "context-mode", "sessions");
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
      "Bash",
      "WebFetch",
      "Read",
      "Grep",
      "Task",
      "mcp__plugin_context-mode_context-mode__ctx_execute",
      "mcp__plugin_context-mode_context-mode__ctx_execute_file",
      "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
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
        message: "Could not read ~/.claude/settings.json",
        fix: "context-mode upgrade",
      });
      return results;
    }

    const hooks = settings.hooks as Record<string, unknown[]> | undefined;

    // Read plugin hooks.json as fallback (Issue #94: plugin installs
    // register hooks in hooks/hooks.json, not in settings.json)
    const pluginHooks = this.readPluginHooks(pluginRoot);

    // Check PreToolUse (settings.json first, then plugin hooks.json fallback)
    const hasPreToolUse = this.checkHookType(hooks, pluginHooks, HOOK_TYPES.PRE_TOOL_USE);
    results.push({
      check: "PreToolUse hook",
      status: hasPreToolUse ? "pass" : "fail",
      message: hasPreToolUse
        ? "PreToolUse hook configured"
        : "No PreToolUse hooks found",
      fix: hasPreToolUse ? undefined : "context-mode upgrade",
    });

    // Check SessionStart (settings.json first, then plugin hooks.json fallback)
    const hasSessionStart = this.checkHookType(hooks, pluginHooks, HOOK_TYPES.SESSION_START);
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

  /** Read plugin hooks from hooks/hooks.json or .claude-plugin/hooks/hooks.json */
  private readPluginHooks(
    pluginRoot: string,
  ): Record<string, unknown[]> | undefined {
    const candidates = [
      join(pluginRoot, "hooks", "hooks.json"),
      join(pluginRoot, ".claude-plugin", "hooks", "hooks.json"),
    ];
    for (const candidate of candidates) {
      try {
        const raw = readFileSync(candidate, "utf-8");
        const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown[]> };
        if (parsed.hooks) return parsed.hooks;
      } catch { /* not available */ }
    }
    return undefined;
  }

  /** Check if a hook type is configured in either settings.json or plugin hooks */
  private checkHookType(
    settingsHooks: Record<string, unknown[]> | undefined,
    pluginHooks: Record<string, unknown[]> | undefined,
    hookType: HookType,
  ): boolean {
    type HookEntry = { matcher?: string; hooks?: Array<{ command?: string }> };

    // Check settings.json
    const fromSettings = settingsHooks?.[hookType] as HookEntry[] | undefined;
    if (fromSettings && fromSettings.length > 0) {
      if (fromSettings.some((entry) => isContextModeHook(entry, hookType))) {
        return true;
      }
    }

    // Fallback: check plugin hooks.json
    const fromPlugin = pluginHooks?.[hookType] as HookEntry[] | undefined;
    if (fromPlugin && fromPlugin.length > 0) {
      if (fromPlugin.some((entry) => isContextModeHook(entry, hookType))) {
        return true;
      }
    }

    return false;
  }

  checkPluginRegistration(): DiagnosticResult {
    const settings = this.readSettings();
    if (!settings) {
      return {
        check: "Plugin registration",
        status: "warn",
        message: "Could not read settings.json",
      };
    }

    const enabledPlugins = settings.enabledPlugins as
      | Record<string, boolean>
      | undefined;
    if (!enabledPlugins) {
      return {
        check: "Plugin registration",
        status: "warn",
        message: "No enabledPlugins section found (might be using standalone MCP mode)",
      };
    }

    const pluginKey = Object.keys(enabledPlugins).find((k) =>
      k.startsWith("context-mode"),
    );

    if (pluginKey && enabledPlugins[pluginKey]) {
      return {
        check: "Plugin registration",
        status: "pass",
        message: `Plugin enabled: ${pluginKey}`,
      };
    }

    return {
      check: "Plugin registration",
      status: "warn",
      message: "context-mode not in enabledPlugins (might be using standalone MCP mode)",
    };
  }

  getInstalledVersion(): string {
    // Primary: read from installed_plugins.json
    try {
      const ipPath = resolve(
        homedir(),
        ".claude",
        "plugins",
        "installed_plugins.json",
      );
      const ipRaw = JSON.parse(readFileSync(ipPath, "utf-8"));
      const plugins = ipRaw.plugins ?? {};
      for (const [key, entries] of Object.entries(plugins)) {
        if (!key.toLowerCase().includes("context-mode")) continue;
        const arr = entries as Array<Record<string, unknown>>;
        if (arr.length > 0 && typeof arr[0].version === "string") {
          return arr[0].version;
        }
      }
    } catch {
      /* fallback below */
    }

    // Fallback: scan common plugin cache locations
    const bases = [
      resolve(homedir(), ".claude"),
      resolve(homedir(), ".config", "claude"),
    ];
    for (const base of bases) {
      const cacheDir = resolve(
        base,
        "plugins",
        "cache",
        "context-mode",
        "context-mode",
      );
      try {
        const entries = readdirSync(cacheDir);
        const versions = entries
          .filter((e) => /^\d+\.\d+\.\d+/.test(e))
          .sort((a, b) => {
            const pa = a.split(".").map(Number);
            const pb = b.split(".").map(Number);
            for (let i = 0; i < 3; i++) {
              if ((pa[i] ?? 0) !== (pb[i] ?? 0))
                return (pa[i] ?? 0) - (pb[i] ?? 0);
            }
            return 0;
          });
        if (versions.length > 0) return versions[versions.length - 1];
      } catch {
        /* continue */
      }
    }
    return "not installed";
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(pluginRoot: string): string[] {
    const settings = this.readSettings() ?? {};
    const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
    const changes: string[] = [];

    // Remove stale context-mode hook entries across ALL hook types (fixes #187).
    // After a marketplace auto-update or version change, settings.json may contain
    // hardcoded paths pointing to deleted version directories (e.g., .../0.9.17/hooks/...).
    // Clean these before registering fresh entries to prevent SessionStart errors.
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

    // If plugin hooks.json already covers all required hooks, skip settings.json
    // registration entirely (Issue #198). Plugin installs don't need settings.json
    // entries — hooks.json with ${CLAUDE_PLUGIN_ROOT} is the source of truth.
    const pluginHooks = this.readPluginHooks(pluginRoot);
    if (pluginHooks) {
      const allCovered = REQUIRED_HOOKS.every((ht) =>
        this.checkHookType(undefined, pluginHooks, ht),
      );
      if (allCovered) {
        // Still write cleaned settings (stale removal) but don't add new entries
        settings.hooks = hooks;
        this.writeSettings(settings);
        changes.push("Skipped settings.json registration — plugin hooks.json is sufficient");
        return changes;
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

  updatePluginRegistry(pluginRoot: string, version: string): void {
    try {
      const ipPath = resolve(
        homedir(),
        ".claude",
        "plugins",
        "installed_plugins.json",
      );
      const ipRaw = JSON.parse(readFileSync(ipPath, "utf-8"));
      for (const [key, entries] of Object.entries(ipRaw.plugins || {})) {
        if (!key.toLowerCase().includes("context-mode")) continue;
        for (const entry of entries as Array<Record<string, unknown>>) {
          entry.installPath = pluginRoot;
          entry.version = version;
          entry.lastUpdated = new Date().toISOString();
        }
      }
      writeFileSync(ipPath, JSON.stringify(ipRaw, null, 2) + "\n", "utf-8");
    } catch {
      /* best effort */
    }
  }

  // ── Internal helpers ───────────────────────────────────

  /**
   * Extract session ID from Claude Code hook input.
   * Priority: transcript_path UUID > session_id field > CLAUDE_SESSION_ID env > ppid fallback.
   */
  private extractSessionId(input: ClaudeCodeHookInput): string {
    if (input.transcript_path) {
      const match = input.transcript_path.match(
        /([a-f0-9-]{36})\.jsonl$/,
      );
      if (match) return match[1];
    }
    if (input.session_id) return input.session_id;
    if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
    return `pid-${process.ppid}`;
  }
}
