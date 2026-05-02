/**
 * adapters/kiro — Kiro IDE/CLI platform adapter.
 *
 * Implements HookAdapter for Kiro's hooks-capable paradigm (json-stdio).
 *
 * Kiro specifics:
 *   - Hooks via agent config files (~/.kiro/agents/<name>.json)
 *   - Config: ~/.kiro/settings/mcp.json (JSON format)
 *   - MCP: full support via mcpServers in mcp.json
 *   - Hook exit codes: 0=allow, 2=block
 *   - Cannot modify tool input (exit codes only)
 *   - Session dir: ~/.kiro/context-mode/sessions/
 *   - Routing file: KIRO.md
 *
 * Sources:
 *   - MCP config: https://kiro.dev/docs/mcp/configuration/
 *   - clientInfo.name: https://github.com/kirodotdev/Kiro/issues/5205 ("Kiro CLI")
 *   - CLI hooks: https://kiro.dev/docs/cli/custom-agents/configuration-reference#hooks-field
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  accessSync,
  constants,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { BaseAdapter } from "../base.js";

import {
  HOOK_TYPES as KIRO_HOOK_TYPES,
  PRE_TOOL_USE_MATCHER_PATTERN as KIRO_PRE_TOOL_USE_MATCHER_PATTERN,
  buildHookCommand as buildKiroHookCommand,
  isContextModeHook as isKiroContextModeHook,
} from "./hooks.js";

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
// Kiro CLI hook input type
// ─────────────────────────────────────────────────────────

interface KiroCLIHookInput {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class KiroAdapter extends BaseAdapter implements HookAdapter {
  constructor() {
    super([".kiro"]);
  }

  readonly name = "Kiro";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: false,
    sessionStart: false,
    canModifyArgs: false,      // Kiro CLI uses exit codes, can't modify input
    canModifyOutput: false,
    canInjectSessionContext: false,
  };

  // ── Input parsing ──────────────────────────────────────

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as KiroCLIHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      sessionId: `pid-${process.ppid}`,
      projectDir: input.cwd ?? process.cwd(),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as KiroCLIHookInput;
    const toolResponse = input.tool_response;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      toolOutput: typeof toolResponse === "string"
        ? toolResponse
        : JSON.stringify(toolResponse ?? ""),
      sessionId: `pid-${process.ppid}`,
      projectDir: input.cwd ?? process.cwd(),
      raw,
    };
  }

  parsePreCompactInput(_raw: unknown): PreCompactEvent {
    throw new Error("Kiro does not support PreCompact hooks");
  }

  parseSessionStartInput(_raw: unknown): SessionStartEvent {
    throw new Error("Kiro does not support SessionStart hooks (yet)");
  }

  // ── Response formatting ────────────────────────────────

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    // Kiro CLI uses exit codes — this format is for adapter interface completeness.
    // The actual hook script handles exit codes directly.
    switch (response.decision) {
      case "deny":
        return { exitCode: 2, stderr: response.reason ?? "Blocked by context-mode" };
      case "context":
        return { exitCode: 0, stdout: response.additionalContext ?? "" };
      default:
        return undefined; // allow — no output needed
    }
  }

  formatPostToolUseResponse(_response: PostToolUseResponse): unknown {
    return undefined; // PostToolUse is non-blocking
  }

  formatPreCompactResponse(_response: PreCompactResponse): unknown {
    return undefined;
  }

  formatSessionStartResponse(_response: SessionStartResponse): unknown {
    return undefined;
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    return resolve(homedir(), ".kiro", "settings", "mcp.json");
  }

  /**
   * Kiro stores per-project context under .kiro/ (steering files, etc).
   * Auto-memory + rule detection use this project-relative dir.
   * (Settings/MCP config still live under ~/.kiro/.)
   */
  getConfigDir(): string {
    return ".kiro";
  }

  getInstructionFiles(): string[] {
    return ["KIRO.md"];
  }

  generateHookConfig(pluginRoot: string): HookRegistration {
    // Kiro CLI hook config format: { preToolUse: [{ matcher, command }] }
    // Note: This generates the entries for agent config files
    return {
      [KIRO_HOOK_TYPES.PRE_TOOL_USE]: [{
        matcher: KIRO_PRE_TOOL_USE_MATCHER_PATTERN,
        hooks: [{ type: "command", command: buildKiroHookCommand(KIRO_HOOK_TYPES.PRE_TOOL_USE, pluginRoot) }],
      }],
      [KIRO_HOOK_TYPES.POST_TOOL_USE]: [{
        matcher: "*",
        hooks: [{ type: "command", command: buildKiroHookCommand(KIRO_HOOK_TYPES.POST_TOOL_USE, pluginRoot) }],
      }],
    };
  }

  readSettings(): Record<string, unknown> | null {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  writeSettings(settings: Record<string, unknown>): void {
    const settingsPath = this.getSettingsPath();
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const defaultAgent = resolve(homedir(), ".kiro", "agents", "default.json");

    try {
      const config = JSON.parse(readFileSync(defaultAgent, "utf-8"));
      const hooks = config.hooks ?? {};

      // Check required hooks
      for (const hookType of [KIRO_HOOK_TYPES.PRE_TOOL_USE]) {
        const entries = hooks[hookType] ?? [];
        const found = entries.some((e: { command?: string }) =>
          isKiroContextModeHook(e, hookType),
        );
        results.push({
          check: `Hook: ${hookType}`,
          status: found ? "pass" : "fail",
          message: found
            ? `context-mode ${hookType} hook found`
            : `context-mode ${hookType} hook not configured`,
          ...(found ? {} : { fix: `Run: context-mode upgrade` }),
        });
      }

      // Check optional hooks
      for (const hookType of [KIRO_HOOK_TYPES.POST_TOOL_USE]) {
        const entries = hooks[hookType] ?? [];
        const found = entries.some((e: { command?: string }) =>
          isKiroContextModeHook(e, hookType),
        );
        results.push({
          check: `Hook: ${hookType}`,
          status: found ? "pass" : "warn",
          message: found
            ? `context-mode ${hookType} hook found`
            : `context-mode ${hookType} hook not configured (optional)`,
        });
      }
    } catch {
      results.push({
        check: "Hook configuration",
        status: "warn",
        message: "Could not read ~/.kiro/agents/default.json",
        fix: "Run: context-mode upgrade",
      });
    }

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      const config = JSON.parse(raw);
      const mcpServers = config?.mcpServers ?? {};

      if ("context-mode" in mcpServers) {
        return {
          check: "MCP registration",
          status: "pass",
          message: "context-mode found in mcpServers config",
        };
      }

      return {
        check: "MCP registration",
        status: "fail",
        message: "context-mode not found in mcpServers",
        fix: "Add context-mode to mcpServers in ~/.kiro/settings/mcp.json",
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: "Could not read ~/.kiro/settings/mcp.json",
      };
    }
  }

  getInstalledVersion(): string {
    try {
      const pkgPath = resolve(
        homedir(),
        ".kiro",
        "extensions",
        "context-mode",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      return pkg.version ?? "unknown";
    } catch {
      return "not installed";
    }
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(pluginRoot: string): string[] {
    const changes: string[] = [];
    const configDir = resolve(homedir(), ".kiro", "agents");
    const defaultAgent = resolve(configDir, "default.json");

    try {
      mkdirSync(configDir, { recursive: true });

      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(readFileSync(defaultAgent, "utf-8"));
      } catch {
        // No existing config — create new
      }

      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;

      // Add preToolUse hook if not present
      const preToolUseEntries = (hooks[KIRO_HOOK_TYPES.PRE_TOOL_USE] ?? []) as Array<Record<string, unknown>>;
      if (!preToolUseEntries.some(e => isKiroContextModeHook(e as { command?: string }, KIRO_HOOK_TYPES.PRE_TOOL_USE))) {
        preToolUseEntries.push({
          matcher: KIRO_PRE_TOOL_USE_MATCHER_PATTERN,
          command: buildKiroHookCommand(KIRO_HOOK_TYPES.PRE_TOOL_USE, pluginRoot),
        });
        hooks[KIRO_HOOK_TYPES.PRE_TOOL_USE] = preToolUseEntries;
        changes.push(`Added ${KIRO_HOOK_TYPES.PRE_TOOL_USE} hook to ${defaultAgent}`);
      }

      // Add postToolUse hook if not present
      const postToolUseEntries = (hooks[KIRO_HOOK_TYPES.POST_TOOL_USE] ?? []) as Array<Record<string, unknown>>;
      if (!postToolUseEntries.some(e => isKiroContextModeHook(e as { command?: string }, KIRO_HOOK_TYPES.POST_TOOL_USE))) {
        postToolUseEntries.push({
          matcher: "*",
          command: buildKiroHookCommand(KIRO_HOOK_TYPES.POST_TOOL_USE, pluginRoot),
        });
        hooks[KIRO_HOOK_TYPES.POST_TOOL_USE] = postToolUseEntries;
        changes.push(`Added ${KIRO_HOOK_TYPES.POST_TOOL_USE} hook to ${defaultAgent}`);
      }

      config.hooks = hooks;
      writeFileSync(defaultAgent, JSON.stringify(config, null, 2), "utf-8");
    } catch (err) {
      changes.push(`Failed to configure hooks: ${(err as Error).message}`);
    }

    return changes;
  }

  setHookPermissions(_pluginRoot: string): string[] {
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // Kiro plugin registry is managed via mcp.json
  }

  getRoutingInstructions(): string {
    const instructionsPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "configs",
      "kiro",
      "KIRO.md",
    );
    try {
      return readFileSync(instructionsPath, "utf-8");
    } catch {
      return "# context-mode\n\nUse context-mode MCP tools (execute, execute_file, batch_execute, fetch_and_index, search) instead of run_command/view_file for data-heavy operations.";
    }
  }
}
