/**
 * adapters/vscode-copilot — VS Code Copilot platform adapter.
 *
 * Extends CopilotBaseAdapter with VS Code-specific logic:
 *   - extractSessionId: VSCODE_PID fallback
 *   - getProjectDir: CLAUDE_PROJECT_DIR
 *   - getSessionDir: .github/ detection with ~/.vscode/ fallback
 *   - checkPluginRegistration: reads .vscode/mcp.json
 *   - getInstalledVersion: scans VS Code extensions dir
 *   - validateHooks: preview status + matcher warnings
 */

import {
  readFileSync,
  mkdirSync,
  accessSync,
  existsSync,
  constants,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import { CopilotBaseAdapter } from "../copilot-base.js";
import type { CopilotHookInput, CopilotHookModule } from "../copilot-base.js";

import type {
  DiagnosticResult,
} from "../types.js";

// ─────────────────────────────────────────────────────────
// Hook constants (re-exported from hooks.ts)
// ─────────────────────────────────────────────────────────

import {
  HOOK_TYPES as VSCODE_HOOK_NAMES,
  HOOK_SCRIPTS as VSCODE_HOOK_SCRIPTS,
  buildHookCommand as buildVSCodeHookCommand,
} from "./hooks.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class VSCodeCopilotAdapter extends CopilotBaseAdapter {
  constructor() {
    // sessionDirSegments unused — vscode-copilot overrides getSessionDir()
    // with .github directory detection fallback logic
    super([".vscode"]);
  }

  readonly name = "VS Code Copilot";

  protected readonly hookModule: CopilotHookModule = {
    HOOK_TYPES: VSCODE_HOOK_NAMES,
    HOOK_SCRIPTS: VSCODE_HOOK_SCRIPTS,
    buildHookCommand: buildVSCodeHookCommand,
  };

  protected readonly hookSubdir = "vscode-copilot";

  // ── Platform-specific overrides ────────────────────────

  protected extractSessionId(input: CopilotHookInput): string {
    if (input.sessionId) return input.sessionId;
    if (process.env.VSCODE_PID) return `vscode-${process.env.VSCODE_PID}`;
    return `pid-${process.ppid}`;
  }

  protected getProjectDir(): string {
    return process.env.CLAUDE_PROJECT_DIR || process.cwd();
  }

  getSessionDir(): string {
    // Prefer .github/context-mode/sessions/ if .github exists,
    // otherwise fall back to ~/.vscode/context-mode/sessions/
    const githubDir = resolve(".github", "context-mode", "sessions");
    const fallbackDir = join(
      homedir(),
      ".vscode",
      "context-mode",
      "sessions",
    );

    const dir = existsSync(resolve(".github")) ? githubDir : fallbackDir;
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** VS Code Copilot honors .github/copilot-instructions.md per project. */
  getConfigDir(): string {
    return ".github";
  }

  getInstructionFiles(): string[] {
    return ["copilot-instructions.md"];
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];

    // Check .github/hooks/ directory for hook JSON files
    const hooksDir = resolve(".github", "hooks");
    try {
      accessSync(hooksDir, constants.R_OK);
    } catch {
      results.push({
        check: "Hooks directory",
        status: "fail",
        message: ".github/hooks/ directory not found",
        fix: "context-mode upgrade",
      });
      return results;
    }

    // Check for context-mode hook config
    const hookConfigPath = resolve(hooksDir, "context-mode.json");
    try {
      const raw = readFileSync(hookConfigPath, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const hooks = config.hooks as Record<string, unknown> | undefined;

      // Check PreToolUse
      if (hooks?.[VSCODE_HOOK_NAMES.PRE_TOOL_USE]) {
        results.push({
          check: "PreToolUse hook",
          status: "pass",
          message: "PreToolUse hook configured in context-mode.json",
        });
      } else {
        results.push({
          check: "PreToolUse hook",
          status: "fail",
          message: "PreToolUse not found in context-mode.json",
          fix: "context-mode upgrade",
        });
      }

      // Check SessionStart
      if (hooks?.[VSCODE_HOOK_NAMES.SESSION_START]) {
        results.push({
          check: "SessionStart hook",
          status: "pass",
          message: "SessionStart hook configured in context-mode.json",
        });
      } else {
        results.push({
          check: "SessionStart hook",
          status: "fail",
          message: "SessionStart not found in context-mode.json",
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

    // Warn about preview status
    results.push({
      check: "API stability",
      status: "warn",
      message:
        "VS Code Copilot hooks are in preview — API may change without notice",
    });

    // Warn about matcher behavior
    results.push({
      check: "Matcher support",
      status: "warn",
      message:
        "Matchers are parsed but IGNORED — all hooks fire on all tools",
    });

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    // Check MCP config in .vscode/mcp.json
    try {
      const mcpConfigPath = resolve(".vscode", "mcp.json");
      const raw = readFileSync(mcpConfigPath, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;

      const servers = config.servers as Record<string, unknown> | undefined;
      if (servers) {
        const hasPlugin = Object.keys(servers).some((k) =>
          k.includes("context-mode"),
        );
        if (hasPlugin) {
          return {
            check: "MCP registration",
            status: "pass",
            message: "context-mode found in .vscode/mcp.json",
          };
        }
      }

      return {
        check: "MCP registration",
        status: "fail",
        message: "context-mode not found in .vscode/mcp.json",
        fix: "Add context-mode server to .vscode/mcp.json",
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: "Could not read .vscode/mcp.json",
      };
    }
  }

  getInstalledVersion(): string {
    // Check VS Code extensions for context-mode
    const extensionDirs = [
      join(homedir(), ".vscode", "extensions"),
      join(homedir(), ".vscode-insiders", "extensions"),
    ];

    for (const extDir of extensionDirs) {
      try {
        const entries = readFileSync(
          join(extDir, "extensions.json"),
          "utf-8",
        );
        const exts = JSON.parse(entries) as Array<Record<string, unknown>>;
        const contextMode = exts.find(
          (e) =>
            typeof e.identifier === "object" &&
            e.identifier !== null &&
            (
              e.identifier as Record<string, unknown>
            ).id?.toString().includes("context-mode"),
        );
        if (contextMode && typeof contextMode.version === "string") {
          return contextMode.version;
        }
      } catch {
        continue;
      }
    }
    return "not installed";
  }
}
