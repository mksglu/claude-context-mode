/**
 * adapters/cursor — Cursor platform adapter.
 *
 * Native Cursor hooks use lower-camel hook names and flat command entries in
 * `.cursor/hooks.json` / `~/.cursor/hooks.json`.
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
  existsSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import type {
  HookAdapter,
  HookParadigm,
  PlatformCapabilities,
  DiagnosticResult,
  PreToolUseEvent,
  PostToolUseEvent,
  SessionStartEvent,
  PreToolUseResponse,
  PostToolUseResponse,
  SessionStartResponse,
  HookRegistration,
} from "../types.js";
import {
  HOOK_TYPES as CURSOR_HOOK_NAMES,
  HOOK_SCRIPTS as CURSOR_HOOK_SCRIPTS,
  PRE_TOOL_USE_MATCHER_PATTERN,
  REQUIRED_HOOKS,
  OPTIONAL_HOOKS,
  isContextModeHook,
  buildHookCommand,
  type HookType,
  type CursorHookCommandEntry,
} from "./hooks.js";

interface StopEvent {
  sessionId: string;
  status: string;
  loopCount: number;
  generationId?: string;
  transcriptPath?: string;
}

interface CursorHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  error_message?: string;
  cwd?: string;
  workspace_roots?: string[];
  conversation_id?: string;
  session_id?: string;
  generation_id?: string;
  source?: string;
  trigger?: string;
}

interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, CursorHookCommandEntry[] | unknown>;
}

const CURSOR_ENTERPRISE_HOOKS_PATH = "/Library/Application Support/Cursor/hooks.json";

export class CursorAdapter implements HookAdapter {
  readonly name = "Cursor";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: false,
    sessionStart: false,
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true,
  };

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as CursorHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as CursorHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      toolOutput: input.tool_output ?? input.error_message,
      isError: Boolean(input.error_message),
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as CursorHookInput;
    const rawSource = input.source ?? input.trigger ?? "startup";

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

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    if (response.decision === "deny") {
      return {
        permission: "deny",
        user_message: response.reason ?? "Blocked by context-mode hook",
      };
    }
    if (response.decision === "modify" && response.updatedInput) {
      return { updated_input: response.updatedInput };
    }
    if (response.decision === "context" && response.additionalContext) {
      return { agent_message: response.additionalContext };
    }
    if (response.decision === "ask") {
      return {
        permission: "ask",
        user_message:
          response.reason ?? "Action requires user confirmation (security policy)",
      };
    }
    // Cursor rejects empty stdout as "no valid response", so adapter callers
    // need the same explicit no-op payload the hook scripts emit at runtime.
    return { agent_message: "" };
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    // Cursor rejects empty stdout as "no valid response", so emit a no-op
    // additional_context payload when there is nothing to inject.
    return { additional_context: response.additionalContext ?? "" };
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    // SessionStart follows the same rule: always emit valid JSON, even when
    // the payload is effectively a no-op.
    return { additional_context: response.context ?? "" };
  }

  parseStopInput(raw: unknown): StopEvent {
    const input = raw as {
      conversation_id: string;
      generation_id?: string;
      status: string;
      loop_count: number;
      transcript_path?: string | null;
    };
    return {
      sessionId: input.conversation_id ?? `pid-${process.ppid}`,
      status: input.status ?? "completed",
      loopCount: input.loop_count ?? 0,
      generationId: input.generation_id,
      transcriptPath: input.transcript_path ?? undefined,
    };
  }

  formatStopResponse(response: { followupMessage?: string }): Record<string, unknown> {
    if (response.followupMessage) {
      return { followup_message: response.followupMessage };
    }
    return {};
  }

  parseAfterAgentResponseInput(raw: unknown): { text: string } {
    const input = raw as { text?: string };
    return { text: input.text ?? "" };
  }

  getSettingsPath(): string {
    return resolve(".cursor", "hooks.json");
  }

  getSessionDir(): string {
    const dir = join(homedir(), ".cursor", "context-mode", "sessions");
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
    const hooks = {
      [CURSOR_HOOK_NAMES.PRE_TOOL_USE]: [
        {
          type: "command",
          command: buildHookCommand(CURSOR_HOOK_NAMES.PRE_TOOL_USE),
          matcher: PRE_TOOL_USE_MATCHER_PATTERN,
          loop_limit: null,
          failClosed: false,
        },
      ],
      [CURSOR_HOOK_NAMES.POST_TOOL_USE]: [
        {
          type: "command",
          command: buildHookCommand(CURSOR_HOOK_NAMES.POST_TOOL_USE),
          loop_limit: null,
          failClosed: false,
        },
      ],
      [CURSOR_HOOK_NAMES.SESSION_START]: [
        {
          type: "command",
          command: buildHookCommand(CURSOR_HOOK_NAMES.SESSION_START),
          loop_limit: null,
          failClosed: false,
        },
      ],
      [CURSOR_HOOK_NAMES.STOP]: [
        {
          type: "command",
          command: buildHookCommand(CURSOR_HOOK_NAMES.STOP),
          loop_limit: null,
          failClosed: false,
        },
      ],
      [CURSOR_HOOK_NAMES.AFTER_AGENT_RESPONSE]: [
        {
          type: "command",
          command: buildHookCommand(CURSOR_HOOK_NAMES.AFTER_AGENT_RESPONSE),
          loop_limit: null,
          failClosed: false,
        },
      ],
    };

    return hooks as unknown as HookRegistration;
  }

  readSettings(): Record<string, unknown> | null {
    for (const configPath of this.getCandidateHookConfigPaths()) {
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
    mkdirSync(resolve(".cursor"), { recursive: true });
    writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const loaded = this.loadNativeHookConfig();

    if (!loaded) {
      results.push({
        check: "Native hook config",
        status: "fail",
        message: "No readable native Cursor hook config found in .cursor/hooks.json or ~/.cursor/hooks.json",
        fix: "context-mode upgrade",
      });
    } else {
      const hooks = loaded.config.hooks ?? {};
      results.push({
        check: "Native hook config",
        status: "pass",
        message: `Loaded ${loaded.path}`,
      });

      for (const hookType of REQUIRED_HOOKS) {
        const entries = hooks[hookType] as CursorHookCommandEntry[] | undefined;
        const hasHook = Array.isArray(entries)
          && entries.some((entry) => isContextModeHook(entry, hookType));

        results.push({
          check: hookType,
          status: hasHook ? "pass" : "fail",
          message: hasHook
            ? `${hookType} hook configured`
            : `${hookType} hook not configured in ${loaded.path}`,
          fix: hasHook ? undefined : "context-mode upgrade",
        });
      }

      for (const hookType of OPTIONAL_HOOKS) {
        const entries = hooks[hookType] as CursorHookCommandEntry[] | undefined;
        const hasHook = Array.isArray(entries)
          && entries.some((entry) => isContextModeHook(entry, hookType));

        results.push({
          check: hookType,
          status: hasHook ? "pass" : "warn",
          message: hasHook
            ? `${hookType} hook configured`
            : `${hookType} hook missing — session event capture will be reduced`,
        });
      }
    }

    if (existsSync(CURSOR_ENTERPRISE_HOOKS_PATH)) {
      results.push({
        check: "Enterprise hook config",
        status: "warn",
        message:
          "Enterprise Cursor hook config detected at /Library/Application Support/Cursor/hooks.json (read-only informational layer)",
      });
    }

    if (this.hasClaudeCompatibilityHooks()) {
      results.push({
        check: "Claude compatibility",
        status: "warn",
        message: "Claude-compatible hooks detected; native Cursor hooks are the supported configuration",
      });
    }

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    const mcpPaths = [resolve(".cursor", "mcp.json"), join(homedir(), ".cursor", "mcp.json")];

    for (const configPath of mcpPaths) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw) as Record<string, unknown>;
        const servers = (config.mcpServers ?? config.servers) as Record<string, unknown> | undefined;
        if (!servers) continue;

        const hasContextMode = Object.entries(servers).some(([name, value]) => {
          if (name.includes("context-mode")) return true;
          if (!value || typeof value !== "object") return false;
          const server = value as Record<string, unknown>;
          return server.command === "context-mode";
        });

        if (hasContextMode) {
          return {
            check: "MCP registration",
            status: "pass",
            message: `context-mode found in ${configPath}`,
          };
        }
      } catch {
        continue;
      }
    }

    return {
      check: "MCP registration",
      status: "warn",
      message: "Could not find context-mode in .cursor/mcp.json or ~/.cursor/mcp.json",
    };
  }

  getInstalledVersion(): string {
    try {
      const output = execSync("cursor --version", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return output.split(/\r?\n/)[0] || "unknown";
    } catch {
      return "not installed";
    }
  }

  configureAllHooks(_pluginRoot: string): string[] {
    const settings = (this.readSettings() as CursorHooksFile | null) ?? { version: 1, hooks: {} };
    const hooks = (settings.hooks ?? {}) as Record<string, CursorHookCommandEntry[] | unknown>;
    const changes: string[] = [];

    this.upsertHookEntry(hooks, CURSOR_HOOK_NAMES.PRE_TOOL_USE, {
      type: "command",
      command: buildHookCommand(CURSOR_HOOK_NAMES.PRE_TOOL_USE),
      matcher: PRE_TOOL_USE_MATCHER_PATTERN,
      loop_limit: null,
      failClosed: false,
    }, changes);

    this.upsertHookEntry(hooks, CURSOR_HOOK_NAMES.POST_TOOL_USE, {
      type: "command",
      command: buildHookCommand(CURSOR_HOOK_NAMES.POST_TOOL_USE),
      loop_limit: null,
      failClosed: false,
    }, changes);

    this.upsertHookEntry(hooks, CURSOR_HOOK_NAMES.SESSION_START, {
      type: "command",
      command: buildHookCommand(CURSOR_HOOK_NAMES.SESSION_START),
      loop_limit: null,
      failClosed: false,
    }, changes);

    this.upsertHookEntry(hooks, CURSOR_HOOK_NAMES.STOP, {
      type: "command",
      command: buildHookCommand(CURSOR_HOOK_NAMES.STOP),
      loop_limit: null,
      failClosed: false,
    }, changes);

    this.upsertHookEntry(hooks, CURSOR_HOOK_NAMES.AFTER_AGENT_RESPONSE, {
      type: "command",
      command: buildHookCommand(CURSOR_HOOK_NAMES.AFTER_AGENT_RESPONSE),
      loop_limit: null,
      failClosed: false,
    }, changes);

    settings.version = 1;
    settings.hooks = hooks;
    this.writeSettings(settings as unknown as Record<string, unknown>);
    changes.push(`Wrote native Cursor hooks to ${this.getSettingsPath()}`);
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
    const hooksDir = join(pluginRoot, "hooks", "cursor");
    for (const scriptName of Object.values(CURSOR_HOOK_SCRIPTS)) {
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
    // Cursor manages extensions and native hooks internally.
  }

  private getCandidateHookConfigPaths(): string[] {
    const paths = [this.getSettingsPath(), join(homedir(), ".cursor", "hooks.json")];
    if (process.platform === "darwin") {
      paths.push(CURSOR_ENTERPRISE_HOOKS_PATH);
    }
    return paths;
  }

  private getProjectDir(input: CursorHookInput): string | undefined {
    return input.cwd
      || input.workspace_roots?.[0]
      || process.env.CURSOR_CWD
      || process.cwd();
  }

  private extractSessionId(input: CursorHookInput): string {
    if (input.conversation_id) return input.conversation_id;
    if (input.session_id) return input.session_id;
    if (process.env.CURSOR_SESSION_ID) return process.env.CURSOR_SESSION_ID;
    if (process.env.CURSOR_TRACE_ID) return process.env.CURSOR_TRACE_ID;
    return `pid-${process.ppid}`;
  }

  private loadNativeHookConfig(): { path: string; config: CursorHooksFile } | null {
    for (const configPath of this.getCandidateHookConfigPaths()) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw) as CursorHooksFile;
        if (config && typeof config === "object") {
          return { path: configPath, config };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private hasClaudeCompatibilityHooks(): boolean {
    const compatPaths = [
      resolve(".claude", "settings.json"),
      resolve(".claude", "settings.local.json"),
      join(homedir(), ".claude", "settings.json"),
    ];

    return compatPaths.some((configPath) => existsSync(configPath));
  }

  private upsertHookEntry(
    hooks: Record<string, CursorHookCommandEntry[] | unknown>,
    hookType: HookType,
    entry: CursorHookCommandEntry,
    changes: string[],
  ): void {
    const existingRaw = hooks[hookType];
    const existing = Array.isArray(existingRaw) ? [...existingRaw] as CursorHookCommandEntry[] : [];
    const idx = existing.findIndex((candidate) => isContextModeHook(candidate, hookType));

    if (idx >= 0) {
      existing[idx] = entry;
      changes.push(`Updated existing ${hookType} hook entry`);
    } else {
      existing.push(entry);
      changes.push(`Added ${hookType} hook entry`);
    }

    hooks[hookType] = existing;
  }
}
