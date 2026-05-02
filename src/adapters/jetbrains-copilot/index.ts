/**
 * adapters/jetbrains-copilot — JetBrains Copilot platform adapter.
 *
 * Extends CopilotBaseAdapter with JetBrains-specific logic:
 *   - extractSessionId: JETBRAINS_CLIENT_ID / IDEA_HOME fallbacks
 *   - getProjectDir: IDEA_INITIAL_DIRECTORY
 *   - checkPluginRegistration: WARN (IDE Settings UI, not CLI-inspectable)
 *   - getInstalledVersion: checks hook config existence
 *   - validateHooks: JetBrains-specific warnings
 */

import {
  readFileSync,
} from "node:fs";
import { join } from "node:path";

import { CopilotBaseAdapter } from "../copilot-base.js";
import type { CopilotHookInput, CopilotHookModule } from "../copilot-base.js";

import type {
  DiagnosticResult,
} from "../types.js";

// ─────────────────────────────────────────────────────────
// Hook constants (re-exported from hooks.ts)
// ─────────────────────────────────────────────────────────

import {
  HOOK_TYPES as JETBRAINS_HOOK_NAMES,
  HOOK_SCRIPTS as JETBRAINS_HOOK_SCRIPTS,
  buildHookCommand as buildJetBrainsHookCommand,
} from "./hooks.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class JetBrainsCopilotAdapter extends CopilotBaseAdapter {
  constructor() {
    super([".config", "JetBrains"]);
  }

  readonly name = "JetBrains Copilot";

  protected readonly hookModule: CopilotHookModule = {
    HOOK_TYPES: JETBRAINS_HOOK_NAMES,
    HOOK_SCRIPTS: JETBRAINS_HOOK_SCRIPTS,
    buildHookCommand: buildJetBrainsHookCommand,
  };

  protected readonly hookSubdir = "jetbrains-copilot";

  // ── Platform-specific overrides ────────────────────────

  protected extractSessionId(input: CopilotHookInput): string {
    if (input.sessionId) return input.sessionId;
    if (process.env.JETBRAINS_CLIENT_ID) {
      return `jetbrains-${process.env.JETBRAINS_CLIENT_ID}`;
    }
    if (process.env.IDEA_HOME) return `idea-${process.pid}`;
    return `pid-${process.ppid}`;
  }

  protected getProjectDir(): string {
    return process.env.IDEA_INITIAL_DIRECTORY || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  }

  /** JetBrains Copilot honors .github/copilot-instructions.md per project. */
  getConfigDir(): string {
    return ".github";
  }

  getInstructionFiles(): string[] {
    return ["copilot-instructions.md"];
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

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
          message: "PreToolUse hook configured in .github/hooks/context-mode.json",
        });
      } else {
        results.push({
          check: "PreToolUse hook",
          status: "fail",
          message: "PreToolUse not found in .github/hooks/context-mode.json",
          fix: "context-mode upgrade",
        });
      }

      if (hooks?.[JETBRAINS_HOOK_NAMES.SESSION_START]) {
        results.push({
          check: "SessionStart hook",
          status: "pass",
          message: "SessionStart hook configured in .github/hooks/context-mode.json",
        });
      } else {
        results.push({
          check: "SessionStart hook",
          status: "fail",
          message: "SessionStart not found in .github/hooks/context-mode.json",
          fix: "context-mode upgrade",
        });
      }
    } catch {
      results.push({
        check: "Hook configuration",
        status: "fail",
        message: "Could not read .github/hooks/context-mode.json",
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
    // JetBrains Copilot stores MCP server registration via the IDE Settings UI
    // (Settings > Tools > GitHub Copilot > MCP > Configure), not in a
    // project-scoped file we can inspect.
    return {
      check: "MCP registration",
      status: "warn",
      message:
        "JetBrains stores MCP config via Settings UI — not CLI-inspectable",
      fix: "Verify in IDE: Settings > Tools > GitHub Copilot > MCP > ensure a context-mode server entry exists",
    };
  }

  getInstalledVersion(): string {
    // JetBrains Copilot registers MCP servers via Settings UI (not
    // CLI-inspectable). All we can check is whether hook config has been
    // written to .github/hooks/context-mode.json by `context-mode upgrade`.
    const settings = this.readSettings();
    const hooks = settings?.hooks as Record<string, unknown> | undefined;
    if (hooks && Object.keys(hooks).length > 0) return "configured";
    return "unknown";
  }
}
