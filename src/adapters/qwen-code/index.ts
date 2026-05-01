/**
 * adapters/qwen-code — Qwen Code platform adapter.
 *
 * Extends ClaudeCodeBaseAdapter (shared wire-protocol parse/format methods)
 * with Qwen Code-specific configuration, diagnostics, and session ID logic.
 *
 * Differences from Claude Code:
 *   - Config dir: ~/.qwen/ (not ~/.claude/)
 *   - Env vars: QWEN_PROJECT_DIR, QWEN_SESSION_ID (not CLAUDE_*)
 *   - Session ID priority: session_id field first (Claude: transcript_path first)
 *   - No plugin registry (Qwen uses settings.json directly)
 *   - MCP clientInfo: qwen-cli-mcp-client-* (pattern)
 *   - 12 hook events (superset of Claude's 5, but context-mode uses the shared 5)
 */

import {
  readFileSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import { ClaudeCodeBaseAdapter, type ClaudeCodeWireInput } from "../claude-code-base.js";

import {
  buildNodeCommand,
  type HookAdapter,
  type HookParadigm,
  type PlatformCapabilities,
  type DiagnosticResult,
  type HookRegistration,
} from "../types.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class QwenCodeAdapter extends ClaudeCodeBaseAdapter implements HookAdapter {
  constructor() {
    super([".qwen"]);
  }

  readonly name = "Qwen Code";
  readonly paradigm: HookParadigm = "json-stdio";
  protected readonly projectDirEnvVar = "QWEN_PROJECT_DIR";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    canModifyArgs: true,
    canModifyOutput: true,
    canInjectSessionContext: true,
  };

  // ── Configuration (differs from Claude Code) ───────────

  getSettingsPath(): string {
    return resolve(homedir(), ".qwen", "settings.json");
  }

  getInstructionFiles(): string[] {
    return ["QWEN.md"];
  }

  generateHookConfig(pluginRoot: string): HookRegistration {
    // Qwen Code passes native tool names in hook stdin (verified from
    // packages/core/src/tools/tool-names.ts). Claude-style names (Bash, Read)
    // are only accepted in permission configs, NOT in hook tool_name payloads.
    const preToolUseMatcher = [
      // Qwen-native names (canonical tool_name in hook stdin)
      "run_shell_command", "read_file", "read_many_files", "grep_search",
      "web_fetch", "agent",
      // MCP tools (same naming convention as Claude Code)
      "mcp__plugin_context-mode_context-mode__ctx_execute",
      "mcp__plugin_context-mode_context-mode__ctx_execute_file",
      "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
    ].join("|");

    return {
      PreToolUse: [
        {
          matcher: preToolUseMatcher,
          hooks: [
            { type: "command", command: buildNodeCommand(`${pluginRoot}/hooks/pretooluse.mjs`) },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: "run_shell_command|read_file|write_file|edit|glob|grep_search|todo_write|agent|ask_user_question|mcp__",
          hooks: [
            { type: "command", command: buildNodeCommand(`${pluginRoot}/hooks/posttooluse.mjs`) },
          ],
        },
      ],
      SessionStart: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: buildNodeCommand(`${pluginRoot}/hooks/sessionstart.mjs`) },
          ],
        },
      ],
      PreCompact: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: buildNodeCommand(`${pluginRoot}/hooks/precompact.mjs`) },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: buildNodeCommand(`${pluginRoot}/hooks/userpromptsubmit.mjs`) },
          ],
        },
      ],
    };
  }

  // ── Settings read/write ────────────────────────────────

  readSettings(): Record<string, unknown> | null {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  writeSettings(settings: Record<string, unknown>): void {
    const { writeFileSync } = require("node:fs");
    writeFileSync(this.getSettingsPath(), JSON.stringify(settings, null, 2));
  }

  // ── Diagnostics (doctor) ───────────────────────────────

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const settings = this.readSettings();
    const hooks = (settings?.hooks ?? {}) as Record<string, unknown>;

    for (const hookName of ["PreToolUse", "PostToolUse", "SessionStart", "PreCompact", "UserPromptSubmit"]) {
      const configured = Array.isArray(hooks[hookName]) && (hooks[hookName] as unknown[]).length > 0;
      results.push({
        check: `${hookName} hook`,
        status: configured ? "pass" : "fail",
        message: configured
          ? `${hookName} hook configured in ~/.qwen/settings.json`
          : `${hookName} hook not found in ~/.qwen/settings.json`,
        ...(configured ? {} : { fix: `Add ${hookName} hook to ~/.qwen/settings.json` }),
      });
    }

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    // Qwen Code has no plugin registry — check for MCP config instead
    try {
      const settings = this.readSettings();
      if (settings?.mcpServers && typeof settings.mcpServers === "object") {
        const servers = settings.mcpServers as Record<string, unknown>;
        if (Object.keys(servers).some(k => k.includes("context-mode"))) {
          return {
            check: "Plugin registration",
            status: "pass",
            message: "context-mode found in mcpServers",
          };
        }
        return {
          check: "Plugin registration",
          status: "fail",
          message: "mcpServers exists but context-mode not found",
          fix: "Add context-mode to mcpServers in ~/.qwen/settings.json",
        };
      }
      return {
        check: "Plugin registration",
        status: "warn",
        message: "No mcpServers in ~/.qwen/settings.json",
      };
    } catch {
      return {
        check: "Plugin registration",
        status: "warn",
        message: "Could not read ~/.qwen/settings.json",
      };
    }
  }

  getInstalledVersion(): string {
    const settings = this.readSettings();
    if (!settings) return "not installed";

    const hooks = settings.hooks as Record<string, unknown[]> | undefined;
    if (!hooks) return "not installed";

    // Check if any hook type has context-mode scripts configured
    const contextModeScripts = [
      "pretooluse.mjs",
      "posttooluse.mjs",
      "precompact.mjs",
      "sessionstart.mjs",
      "userpromptsubmit.mjs",
    ];
    for (const [, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const e = entry as { hooks?: Array<{ command?: string }> };
        if (e.hooks?.some((h) =>
          h.command && contextModeScripts.some((s) => h.command!.includes(s)),
        )) {
          return "installed (hooks configured)";
        }
      }
    }

    return "not installed";
  }

  configureAllHooks(pluginRoot: string): string[] {
    const settings = this.readSettings() ?? {};
    const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
    const changes: string[] = [];

    // ── Phase 1: Clean stale context-mode hooks ──────────
    // After an upgrade, settings.json may contain hardcoded paths
    // pointing to deleted version directories. Remove those.
    for (const hookType of Object.keys(hooks)) {
      const entries = hooks[hookType];
      if (!Array.isArray(entries)) continue;

      const filtered = (entries as Array<Record<string, unknown>>).filter(
        (entry) => {
          const e = entry as { hooks?: Array<{ command?: string }> };
          const commands = e.hooks ?? [];

          // Preserve entries that are not context-mode hooks
          const isContextMode = commands.some(
            (h) => h.command && /context-mode|pretooluse|posttooluse|precompact|sessionstart|userpromptsubmit/i.test(h.command),
          );
          if (!isContextMode) return true;

          // For context-mode hooks, check if referenced script files exist
          return commands.every((h) => {
            if (!h.command) return true;
            // Extract path from both new ("nodePath" "scriptPath.mjs") and legacy (node .../script.mjs) formats
            const newFmt = h.command.match(/"[^"]+"\s+"([^"]+\.mjs)"/);
            const legacyFmt = h.command.match(/node\s+"?([^"]+\.mjs)"?/);
            const scriptMatch = newFmt || legacyFmt;
            if (!scriptMatch) return true; // CLI dispatcher format, always valid
            return existsSync(scriptMatch[1]);
          });
        },
      );

      const removed = entries.length - filtered.length;
      if (removed > 0) {
        hooks[hookType] = filtered;
        changes.push(`Removed ${removed} stale ${hookType} hook(s)`);
      }
    }

    // ── Phase 2: Register fresh hooks ────────────────────
    const hookTypes: Array<{
      name: string;
      script: string;
      matcher: string;
    }> = [
      {
        name: "PreToolUse",
        script: "pretooluse.mjs",
        matcher: [
          "run_shell_command", "read_file", "read_many_files", "grep_search",
          "web_fetch", "agent",
          "mcp__plugin_context-mode_context-mode__ctx_execute",
          "mcp__plugin_context-mode_context-mode__ctx_execute_file",
          "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
        ].join("|"),
      },
      {
        name: "SessionStart",
        script: "sessionstart.mjs",
        matcher: "",
      },
    ];

    for (const { name, script, matcher } of hookTypes) {
      const entry = {
        matcher,
        hooks: [{ type: "command", command: buildNodeCommand(`${pluginRoot}/hooks/${script}`) }],
      };

      const existing = hooks[name] as Array<Record<string, unknown>> | undefined;
      if (existing && Array.isArray(existing)) {
        // Replace existing context-mode entry or append
        const idx = existing.findIndex((e) => {
          const typed = e as { hooks?: Array<{ command?: string }> };
          return typed.hooks?.some(
            (h) => h.command?.includes(script),
          ) ?? false;
        });
        if (idx >= 0) {
          existing[idx] = entry;
          changes.push(`Updated ${name} hook`);
        } else {
          existing.push(entry);
          changes.push(`Added ${name} hook`);
        }
        hooks[name] = existing;
      } else {
        hooks[name] = [entry];
        changes.push(`Created ${name} hooks`);
      }
    }

    settings.hooks = hooks;
    this.writeSettings(settings);
    return changes;
  }

  setHookPermissions(_pluginRoot: string): string[] {
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // No plugin registry in Qwen Code
  }

  getRoutingInstructionsConfig() {
    const instructionsPath = resolve(
      join(homedir(), ".qwen", "QWEN.md"),
    );
    return {
      instructionsPath,
      targetPath: "QWEN.md",
      platformName: "Qwen Code",
    };
  }

  // ── Session ID extraction (differs from Claude Code) ───
  // Qwen Code prioritizes session_id field, then QWEN_SESSION_ID env var.
  // Claude Code prioritizes transcript_path UUID first.

  protected extractSessionId(input: ClaudeCodeWireInput): string {
    if (input.session_id) return input.session_id;
    if (input.transcript_path) {
      const match = input.transcript_path.match(
        /([a-f0-9-]{36})\.jsonl$/,
      );
      if (match) return match[1];
    }
    if (process.env.QWEN_SESSION_ID) return process.env.QWEN_SESSION_ID;
    return `pid-${process.ppid}`;
  }
}
