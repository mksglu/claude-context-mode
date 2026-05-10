/**
 * adapters/codex — Codex CLI platform adapter.
 *
 * Implements HookAdapter for Codex CLI's JSON stdin/stdout paradigm.
 *
 * Codex CLI hook specifics:
 *   - 6 hook events: PreToolUse, PostToolUse, PreCompact, SessionStart, UserPromptSubmit, Stop
 *   - Same wire protocol as Claude Code (JSON stdin → stdout)
 *   - Config: $CODEX_HOME or ~/.codex (hooks.json + config.toml)
 *   - Session dir: $CODEX_HOME/context-mode/sessions/
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
  mkdirSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BaseAdapter } from "../base.js";
import { resolveCodexConfigDir } from "./paths.js";

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

type HooksConfigReadResult =
  | { ok: true; config: CodexHooksFile }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "invalid_json"; error: string }
  | { ok: false; reason: "read_error"; error: string };

const PRE_TOOL_USE_MATCHER_PATTERN =
  "local_shell|shell|shell_command|exec_command|container.exec|functions\\.exec_command|Bash|Shell|apply_patch|functions\\.apply_patch|Edit|Write|grep_files|ctx_execute|ctx_execute_file|ctx_batch_execute|ctx_fetch_and_index|ctx_search|ctx_index|mcp__.*__ctx_execute|mcp__.*__ctx_execute_file|mcp__.*__ctx_batch_execute|mcp__.*__ctx_fetch_and_index|mcp__.*__ctx_search|mcp__.*__ctx_index";

const CODEX_HOOK_COMMANDS = {
  PreToolUse: "context-mode hook codex pretooluse",
  PostToolUse: "context-mode hook codex posttooluse",
  SessionStart: "context-mode hook codex sessionstart",
  PreCompact: "context-mode hook codex precompact",
  UserPromptSubmit: "context-mode hook codex userpromptsubmit",
  Stop: "context-mode hook codex stop",
} as const;

const LEGACY_HOOK_PATH_SUFFIXES: Record<keyof typeof CODEX_HOOK_COMMANDS, string[]> = {
  PreToolUse: ["hooks/pretooluse.mjs", "hooks/codex/pretooluse.mjs"],
  PostToolUse: ["hooks/posttooluse.mjs", "hooks/codex/posttooluse.mjs"],
  SessionStart: ["hooks/sessionstart.mjs", "hooks/codex/sessionstart.mjs"],
  PreCompact: ["hooks/precompact.mjs", "hooks/codex/precompact.mjs"],
  UserPromptSubmit: ["hooks/userpromptsubmit.mjs", "hooks/codex/userpromptsubmit.mjs"],
  Stop: ["hooks/stop.mjs", "hooks/codex/stop.mjs"],
};

function getTomlSection(raw: string, sectionName: string): string | null {
  const lines = raw.split(/\r?\n/);
  let inSection = false;
  const body: string[] = [];

  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (section) {
      if (inSection) break;
      inSection = section[1]?.trim() === sectionName;
      continue;
    }
    if (inSection) body.push(line);
  }

  return inSection ? body.join("\n") : null;
}

function hasCodexHooksFeature(raw: string): boolean {
  const features = getTomlSection(raw, "features");
  return features !== null && /^\s*hooks\s*=\s*true\s*(?:#.*)?$/mi.test(features);
}

function hasDeprecatedCodexHooksFeature(raw: string): boolean {
  const features = getTomlSection(raw, "features");
  return features !== null && /^\s*codex_hooks\s*=\s*true\s*(?:#.*)?$/mi.test(features);
}

function ensureCodexHooksFeature(raw: string): { text: string; changed: boolean } {
  if (hasCodexHooksFeature(raw)) return { text: raw, changed: false };

  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const featuresIndex = lines.findIndex((line) => /^\s*\[features\]\s*(?:#.*)?$/.test(line));

  if (featuresIndex === -1) {
    const prefix = raw.length > 0 && !raw.endsWith("\n") ? newline : "";
    return {
      text: `${raw}${prefix}[features]${newline}hooks = true${newline}`,
      changed: true,
    };
  }

  let endIndex = lines.length;
  for (let i = featuresIndex + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(lines[i] ?? "")) {
      endIndex = i;
      break;
    }
  }

  for (let i = featuresIndex + 1; i < endIndex; i++) {
    if (/^\s*hooks\s*=/.test(lines[i] ?? "")) {
      lines[i] = "hooks = true";
      return { text: lines.join(newline), changed: true };
    }
  }

  lines.splice(featuresIndex + 1, 0, "hooks = true");
  return { text: lines.join(newline), changed: true };
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
    preCompact: true,
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
    // Codex PreCompact currently accepts only universal hook fields.
    // The hook script stores snapshots in context-mode's DB; SessionStart
    // injects them after compaction.
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

  getConfigDir(_projectDir?: string): string {
    return resolveCodexConfigDir();
  }

  getSettingsPath(): string {
    return join(this.getConfigDir(), "config.toml");
  }

  getSessionDir(): string {
    const dir = join(this.getConfigDir(), "context-mode", "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // C2 narrowing (2026-05): the historical `getSessionDBPath` /
  // `getSessionEventsPath` overrides were removed. Both delegated to the
  // same canonical helpers (`resolveSessionDbPath` / `hashProjectDirCanonical`
  // + `getWorktreeSuffix`) which already normalize the path internally —
  // the explicit `normalizeWorktreePath` here was a no-op. Callers now reach
  // the helpers directly through `adapter.getSessionDir()`.

  getInstructionFiles(): string[] {
    // Codex CLI honors AGENTS.md plus an optional override file.
    return ["AGENTS.md", "AGENTS.override.md"];
  }

  getMemoryDir(): string {
    // Codex uses "memories" (plural), not the default "memory".
    return join(this.getConfigDir(), "memories");
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
      PreCompact: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: CODEX_HOOK_COMMANDS.PreCompact,
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
    const results: DiagnosticResult[] = [];

    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      const enabled = hasCodexHooksFeature(raw);
      const deprecatedOnly = !enabled && hasDeprecatedCodexHooksFeature(raw);

      results.push({
        check: "Codex hooks feature flag",
        status: enabled ? "pass" : "fail",
        message: enabled
          ? `[features].hooks enabled in ${this.getSettingsPath()}`
          : deprecatedOnly
            ? `[features].codex_hooks is deprecated; [features].hooks is missing in ${this.getSettingsPath()}`
            : `[features].hooks missing from ${this.getSettingsPath()}`,
        ...(enabled ? {} : { fix: "context-mode upgrade" }),
      });
    } catch {
      results.push({
        check: "Codex hooks feature flag",
        status: "warn",
        message: `Could not read ${this.getSettingsPath()}`,
        fix: "context-mode upgrade",
      });
    }

    const hookConfig = this.readHooksConfig();
    if (!hookConfig.ok) {
      if (hookConfig.reason === "missing") {
        return results.concat([{
          check: "Hooks config",
          status: "fail",
          message: `No readable ${this.getHooksPath()} found`,
          fix: "Copy configs/codex/hooks.json to hooks.json or run context-mode upgrade",
        }]);
      }
      if (hookConfig.reason === "invalid_json") {
        return results.concat([{
          check: "Hooks config",
          status: "fail",
          message: `${this.getHooksPath()} is not valid JSON: ${hookConfig.error}`,
          fix: "Repair hooks.json so it contains valid JSON, then rerun context-mode upgrade if needed",
        }]);
      }

      return results.concat([{
        check: "Hooks config",
        status: "fail",
        message: `Could not read ${this.getHooksPath()}: ${hookConfig.error}`,
        fix: "Check permissions and file accessibility for hooks.json, then rerun context-mode upgrade if needed",
      }]);
    }

    if (!hookConfig.config.hooks) {
      return results.concat([{
        check: "Hooks config",
        status: "fail",
        message: `${this.getHooksPath()} is missing the top-level hooks object`,
        fix: `Update ${this.getHooksPath()} to match configs/codex/hooks.json`,
      }]);
    }

    const expected = this.generateHookConfig("");
    return results.concat(Object.entries(expected).map(([hookName, entries]) => {
      const actualEntries = hookConfig.config.hooks?.[hookName];
      const expectedEntry = entries[0];
      const ok = Array.isArray(actualEntries)
        && actualEntries.some((entry) => this.isExpectedHookEntry(hookName, entry, expectedEntry));
      const missingStatus = hookName === "PreCompact" ? "warn" : "fail";

      return {
        check: `${hookName} hook`,
        status: ok ? "pass" : missingStatus,
        message: ok
          ? `${hookName} hook configured in ${this.getHooksPath()}`
          : hookName === "PreCompact"
            ? `${hookName} hook missing or not pointing to context-mode; compaction snapshots require a Codex build that emits PreCompact`
            : `${hookName} hook missing or not pointing to context-mode`,
        fix: ok ? undefined : `Update ${this.getHooksPath()} to match configs/codex/hooks.json`,
      };
    }));
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
          fix: `Add context-mode to [mcp_servers] in ${this.getSettingsPath()}`,
        };
      }

      return {
        check: "MCP registration",
        status: "fail",
        message: "No [mcp_servers] section in config.toml",
        fix: `Add [mcp_servers.context-mode] to ${this.getSettingsPath()}`,
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: `Could not read ${this.getSettingsPath()}`,
      };
    }
  }

  getInstalledVersion(): string {
    // Codex CLI has no marketplace or plugin system
    return "not installed";
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(pluginRoot: string): string[] {
    const hookConfig = this.readHooksConfig();
    const changes: string[] = [];
    let hookFile: CodexHooksFile;
    if (hookConfig.ok) {
      hookFile = hookConfig.config;
    } else if (hookConfig.reason === "missing") {
      hookFile = { hooks: {} };
    } else if (hookConfig.reason === "invalid_json") {
      const backupPath = this.backupFile(this.getHooksPath(), ".broken");
      changes.push(`Backed up malformed Codex hooks to ${backupPath}`);
      hookFile = { hooks: {} };
    } else {
      throw new Error(`Failed to update ${this.getHooksPath()}: ${hookConfig.error}`);
    }

    const hooks = hookFile.hooks && typeof hookFile.hooks === "object" && !Array.isArray(hookFile.hooks)
      ? hookFile.hooks
      : {};
    const desiredHooks = this.generateHookConfig(pluginRoot);

    for (const [hookName, entries] of Object.entries(desiredHooks)) {
      this.upsertManagedHookEntry(hooks, hookName, entries[0], changes);
    }

    if (changes.length > 0) {
      hookFile.hooks = hooks;
      this.writeHooksConfig(hookFile);
      changes.push(`Wrote native Codex hooks to ${this.getHooksPath()}`);
    }

    const settingsPath = this.getSettingsPath();
    let settingsRaw = "";
    try {
      settingsRaw = readFileSync(settingsPath, "utf-8");
    } catch {
      settingsRaw = "";
    }

    const enabledSettings = ensureCodexHooksFeature(settingsRaw);
    if (enabledSettings.changed) {
      const newline = enabledSettings.text.includes("\r\n") ? "\r\n" : "\n";
      const text = enabledSettings.text.endsWith("\n")
        ? enabledSettings.text
        : `${enabledSettings.text}${newline}`;
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, text, "utf-8");
      changes.push("Enabled Codex hooks feature flag");
    }

    return changes;
  }

  backupSettings(): string | null {
    let firstBackupPath: string | null = null;
    for (const settingsPath of [this.getHooksPath(), this.getSettingsPath()]) {
      try {
        accessSync(settingsPath, constants.R_OK);
        const backupPath = this.backupFile(settingsPath);
        firstBackupPath ??= backupPath;
      } catch {
        continue;
      }
    }
    return firstBackupPath;
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

  getHooksPath(): string {
    return join(this.getConfigDir(), "hooks.json");
  }

  private backupFile(filePath: string, suffix = ""): string {
    const backupPath = suffix
      ? `${filePath}${suffix}-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`
      : `${filePath}.bak`;
    copyFileSync(filePath, backupPath);
    return backupPath;
  }

  private readHooksConfig(): HooksConfigReadResult {
    const hooksPath = this.getHooksPath();
    try {
      return { ok: true, config: JSON.parse(readFileSync(hooksPath, "utf-8")) as CodexHooksFile };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";

      if (code === "ENOENT") {
        return { ok: false, reason: "missing" };
      }
      if (error instanceof SyntaxError) {
        return { ok: false, reason: "invalid_json", error: message };
      }
      return { ok: false, reason: "read_error", error: message };
    }
  }

  private writeHooksConfig(config: CodexHooksFile): void {
    const hooksPath = this.getHooksPath();
    mkdirSync(dirname(hooksPath), { recursive: true });
    writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
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
    if (!entry || typeof entry !== "object") return false;
    if (hookName === "PreToolUse" && entry.matcher !== expectedEntry.matcher) {
      return false;
    }
    return this.entryContainsManagedCommand(hookName, entry);
  }

  private isManagedContextModeEntry(hookName: string, entry: HookEntry): boolean {
    if (!entry || typeof entry !== "object") return false;
    return this.entryContainsManagedCommand(hookName, entry);
  }

  private entryContainsManagedCommand(hookName: string, entry: HookEntry): boolean {
    const normalizedCommands = (Array.isArray(entry.hooks) ? entry.hooks : [])
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
