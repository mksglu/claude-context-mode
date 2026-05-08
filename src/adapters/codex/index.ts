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
  writeFileSync,
  accessSync,
  copyFileSync,
  constants,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { BaseAdapter } from "../base.js";

import {
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
  type HookEntry,
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

interface CodexHooksFile {
  hooks?: HookRegistration;
}

const PRE_TOOL_USE_MATCHER_PATTERN =
  "local_shell|shell|shell_command|exec_command|container.exec|Bash|Shell|grep_files|mcp__plugin_context-mode_context-mode__ctx_execute|mcp__plugin_context-mode_context-mode__ctx_execute_file|mcp__plugin_context-mode_context-mode__ctx_batch_execute";

const CODEX_HOOK_COMMANDS = {
  PreToolUse: "context-mode hook codex pretooluse",
  PostToolUse: "context-mode hook codex posttooluse",
  SessionStart: "context-mode hook codex sessionstart",
  UserPromptSubmit: "context-mode hook codex userpromptsubmit",
  Stop: "context-mode hook codex stop",
} as const;

const LEGACY_HOOK_PATH_SUFFIXES: Record<keyof typeof CODEX_HOOK_COMMANDS, string[]> = {
  PreToolUse: ["hooks/pretooluse.mjs", "hooks/codex/pretooluse.mjs"],
  PostToolUse: ["hooks/posttooluse.mjs", "hooks/codex/posttooluse.mjs"],
  SessionStart: ["hooks/sessionstart.mjs", "hooks/codex/sessionstart.mjs"],
  UserPromptSubmit: ["hooks/userpromptsubmit.mjs", "hooks/codex/userpromptsubmit.mjs"],
  Stop: ["hooks/stop.mjs", "hooks/codex/stop.mjs"],
};

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

  generateHookConfig(_pluginRoot: string): HookRegistration {
    return {
      PreToolUse: [
        {
          matcher: PRE_TOOL_USE_MATCHER_PATTERN,
          hooks: [
            {
              type: "command",
              command: CODEX_HOOK_COMMANDS.PreToolUse,
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
              command: CODEX_HOOK_COMMANDS.PostToolUse,
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
              command: CODEX_HOOK_COMMANDS.SessionStart,
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
              command: CODEX_HOOK_COMMANDS.UserPromptSubmit,
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
              command: CODEX_HOOK_COMMANDS.Stop,
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
    const hookConfig = this.readHooksConfig();
    if (!hookConfig?.hooks) {
      return [{
        check: "Hooks config",
        status: "fail",
        message: "No readable ~/.codex/hooks.json found",
        fix: "Copy configs/codex/hooks.json to ~/.codex/hooks.json or run context-mode upgrade",
      }];
    }

    const expected = this.generateHookConfig("");
    return Object.entries(expected).map(([hookName, entries]) => {
      const actualEntries = hookConfig.hooks?.[hookName];
      const expectedEntry = entries[0];
      const ok = Array.isArray(actualEntries)
        && actualEntries.some((entry) => this.isExpectedHookEntry(hookName, entry, expectedEntry));

      return {
        check: `${hookName} hook`,
        status: ok ? "pass" : "fail",
        message: ok
          ? `${hookName} hook configured in ~/.codex/hooks.json`
          : `${hookName} hook missing or not pointing to context-mode`,
        fix: ok ? undefined : "Update ~/.codex/hooks.json to match configs/codex/hooks.json",
      };
    });
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

  configureAllHooks(pluginRoot: string): string[] {
    const hookFile = this.readHooksConfig() ?? { hooks: {} };
    const hooks = hookFile.hooks ?? {};
    const desiredHooks = this.generateHookConfig(pluginRoot);
    const changes: string[] = [];

    for (const [hookName, entries] of Object.entries(desiredHooks)) {
      this.upsertManagedHookEntry(hooks, hookName, entries[0], changes);
    }

    if (changes.length > 0) {
      hookFile.hooks = hooks;
      this.writeHooksConfig(hookFile);
      changes.push(`Wrote native Codex hooks to ${this.getHooksPath()}`);
    }

    return changes;
  }

  backupSettings(): string | null {
    for (const settingsPath of [this.getHooksPath(), this.getSettingsPath()]) {
      try {
        accessSync(settingsPath, constants.R_OK);
        const backupPath = settingsPath + ".bak";
        copyFileSync(settingsPath, backupPath);
        return backupPath;
      } catch {
        continue;
      }
    }
    return null;
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

  private getHooksPath(): string {
    return resolve(homedir(), ".codex", "hooks.json");
  }

  private readHooksConfig(): CodexHooksFile | null {
    try {
      return JSON.parse(readFileSync(this.getHooksPath(), "utf-8")) as CodexHooksFile;
    } catch {
      return null;
    }
  }

  private writeHooksConfig(config: CodexHooksFile): void {
    writeFileSync(this.getHooksPath(), JSON.stringify(config, null, 2) + "\n", "utf-8");
  }

  private upsertManagedHookEntry(
    hooks: HookRegistration,
    hookName: string,
    expectedEntry: HookEntry,
    changes: string[],
  ): void {
    const currentEntries = Array.isArray(hooks[hookName]) ? [...hooks[hookName]] : [];
    const managedIndices = currentEntries
      .map((entry, index) => this.isManagedContextModeEntry(hookName, entry) ? index : -1)
      .filter((index) => index >= 0);

    if (managedIndices.length === 0) {
      currentEntries.push(expectedEntry);
      hooks[hookName] = currentEntries;
      changes.push(`Added ${hookName} hook`);
      return;
    }

    const primaryIndex = managedIndices[0];
    if (JSON.stringify(currentEntries[primaryIndex]) !== JSON.stringify(expectedEntry)) {
      currentEntries[primaryIndex] = expectedEntry;
      changes.push(`Updated ${hookName} hook`);
    }

    for (const duplicateIndex of managedIndices.slice(1).reverse()) {
      currentEntries.splice(duplicateIndex, 1);
      changes.push(`Removed duplicate ${hookName} context-mode hook`);
    }

    hooks[hookName] = currentEntries;
  }

  private isExpectedHookEntry(
    hookName: string,
    entry: HookEntry,
    expectedEntry: HookEntry,
  ): boolean {
    if (hookName === "PreToolUse" && entry.matcher !== expectedEntry.matcher) {
      return false;
    }
    return this.entryContainsManagedCommand(hookName, entry);
  }

  private isManagedContextModeEntry(hookName: string, entry: HookEntry): boolean {
    return this.entryContainsManagedCommand(hookName, entry);
  }

  private entryContainsManagedCommand(hookName: string, entry: HookEntry): boolean {
    const normalizedCommands = entry.hooks
      .map((hook) => this.normalizeCommand(hook.command))
      .filter((command) => command.length > 0);
    const expectedCliCommand = this.normalizeCommand(
      CODEX_HOOK_COMMANDS[hookName as keyof typeof CODEX_HOOK_COMMANDS] ?? "",
    );
    const legacySuffixes = LEGACY_HOOK_PATH_SUFFIXES[hookName as keyof typeof LEGACY_HOOK_PATH_SUFFIXES] ?? [];

    return normalizedCommands.some((command) =>
      command.includes(expectedCliCommand)
      || legacySuffixes.some((suffix) => command.includes(suffix)),
    );
  }

  private normalizeCommand(command: string | undefined): string {
    return (command ?? "").replace(/\\/g, "/");
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
