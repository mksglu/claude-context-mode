/**
 * adapters/jetbrains-copilot — JetBrains Copilot platform adapter.
 *
 * Implements HookAdapter for JetBrains Copilot's JSON stdin/stdout hook paradigm.
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

import {
  HOOK_TYPES as JETBRAINS_HOOK_NAMES,
  HOOK_SCRIPTS as JETBRAINS_HOOK_SCRIPTS,
  buildHookCommand as buildJetBrainsHookCommand,
} from "./hooks.js";

interface JetBrainsCopilotHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  is_error?: boolean;
  sessionId?: string;
  source?: string;
}

export class JetBrainsCopilotAdapter implements HookAdapter {
  readonly name = "JetBrains Copilot";
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

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as JetBrainsCopilotHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as JetBrainsCopilotHookInput;
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
    const input = raw as JetBrainsCopilotHookInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as JetBrainsCopilotHookInput;
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
          hookEventName: JETBRAINS_HOOK_NAMES.PRE_TOOL_USE,
          updatedInput: response.updatedInput,
        },
      };
    }
    if (response.decision === "context" && response.additionalContext) {
      return {
        hookSpecificOutput: {
          hookEventName: JETBRAINS_HOOK_NAMES.PRE_TOOL_USE,
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
    return undefined;
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    if (response.updatedOutput) {
      return {
        hookSpecificOutput: {
          hookEventName: JETBRAINS_HOOK_NAMES.POST_TOOL_USE,
          decision: "block",
          reason: response.updatedOutput,
        },
      };
    }
    if (response.additionalContext) {
      return {
        hookSpecificOutput: {
          hookEventName: JETBRAINS_HOOK_NAMES.POST_TOOL_USE,
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

  getSettingsPath(): string {
    return resolve(".idea", "mcp.json");
  }

  getSessionDir(): string {
    const dir = join(homedir(), ".config", "JetBrains", "context-mode", "sessions");
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
      [JETBRAINS_HOOK_NAMES.PRE_TOOL_USE]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildJetBrainsHookCommand(JETBRAINS_HOOK_NAMES.PRE_TOOL_USE, pluginRoot),
            },
          ],
        },
      ],
      [JETBRAINS_HOOK_NAMES.POST_TOOL_USE]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildJetBrainsHookCommand(JETBRAINS_HOOK_NAMES.POST_TOOL_USE, pluginRoot),
            },
          ],
        },
      ],
      [JETBRAINS_HOOK_NAMES.PRE_COMPACT]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildJetBrainsHookCommand(JETBRAINS_HOOK_NAMES.PRE_COMPACT, pluginRoot),
            },
          ],
        },
      ],
      [JETBRAINS_HOOK_NAMES.SESSION_START]: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildJetBrainsHookCommand(JETBRAINS_HOOK_NAMES.SESSION_START, pluginRoot),
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
    const configPath = this.getSettingsPath();
    mkdirSync(resolve(".idea"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(settings, null, 2) + "\n",
      "utf-8",
    );
  }

  validateHooks(pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];

    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const hooks = config.hooks as Record<string, unknown> | undefined;

      if (hooks?.[JETBRAINS_HOOK_NAMES.PRE_TOOL_USE]) {
        results.push({
          check: "PreToolUse hook",
          status: "pass",
          message: "PreToolUse hook configured in .idea/mcp.json",
        });
      } else {
        results.push({
          check: "PreToolUse hook",
          status: "fail",
          message: "PreToolUse not found in .idea/mcp.json",
          fix: "context-mode upgrade",
        });
      }

      if (hooks?.[JETBRAINS_HOOK_NAMES.SESSION_START]) {
        results.push({
          check: "SessionStart hook",
          status: "pass",
          message: "SessionStart hook configured in .idea/mcp.json",
        });
      } else {
        results.push({
          check: "SessionStart hook",
          status: "fail",
          message: "SessionStart not found in .idea/mcp.json",
          fix: "context-mode upgrade",
        });
      }
    } catch {
      results.push({
        check: "Hook configuration",
        status: "fail",
        message: "Could not read .idea/mcp.json",
        fix: "context-mode upgrade",
      });
    }

    results.push({
      check: "Hook scripts",
      status: "warn",
      message: `JetBrains hook wrappers should resolve to ${pluginRoot}/hooks/jetbrains-copilot/*.mjs`,
    });

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    try {
      const mcpConfigPath = resolve(".idea", "mcp.json");
      const raw = readFileSync(mcpConfigPath, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;

      const servers = (config.mcpServers ?? config.servers) as Record<string, unknown> | undefined;
      if (servers) {
        const hasPlugin = Object.keys(servers).some((k) =>
          k.includes("context-mode"),
        );
        if (hasPlugin) {
          return {
            check: "MCP registration",
            status: "pass",
            message: "context-mode found in .idea/mcp.json",
          };
        }
      }

      return {
        check: "MCP registration",
        status: "fail",
        message: "context-mode not found in .idea/mcp.json",
        fix: "Add context-mode server to .idea/mcp.json",
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: "Could not read .idea/mcp.json",
      };
    }
  }

  getInstalledVersion(): string {
    return "unknown";
  }

  configureAllHooks(pluginRoot: string): string[] {
    const changes: string[] = [];
    const settings = this.readSettings() ?? {};
    const hooks = (settings.hooks as Record<string, unknown> | undefined) ?? {};

    const hookTypes = [
      JETBRAINS_HOOK_NAMES.PRE_TOOL_USE,
      JETBRAINS_HOOK_NAMES.POST_TOOL_USE,
      JETBRAINS_HOOK_NAMES.PRE_COMPACT,
      JETBRAINS_HOOK_NAMES.SESSION_START,
    ];

    for (const hookType of hookTypes) {
      const script = JETBRAINS_HOOK_SCRIPTS[hookType];
      if (!script) continue;

      hooks[hookType] = [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildJetBrainsHookCommand(hookType, pluginRoot),
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
    const hooksDir = join(pluginRoot, "hooks", "jetbrains-copilot");
    for (const scriptName of Object.values(JETBRAINS_HOOK_SCRIPTS)) {
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
    // JetBrains manages plugins through IDE marketplaces.
  }

  private extractSessionId(input: JetBrainsCopilotHookInput): string {
    if (input.sessionId) return input.sessionId;
    if (process.env.JETBRAINS_CLIENT_ID) {
      return `jetbrains-${process.env.JETBRAINS_CLIENT_ID}`;
    }
    if (process.env.IDEA_HOME) return `idea-${process.pid}`;
    return `pid-${process.ppid}`;
  }

  private getProjectDir(): string {
    return process.env.IDEA_INITIAL_DIRECTORY || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  }
}

