/**
 * adapters/zed — Zed editor platform adapter.
 *
 * Implements HookAdapter for Zed's MCP-only paradigm.
 *
 * Zed hook specifics:
 *   - NO hook support — Zed is an editor, not a CLI with hook pipelines
 *   - Config: ~/.config/zed/settings.json (JSON format)
 *   - MCP: full support via context_servers section in settings.json
 *   - All capabilities are false — MCP is the only integration path
 *   - Session dir: ~/.config/zed/context-mode/sessions/
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
} from "../types.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class ZedAdapter extends BaseAdapter implements HookAdapter {
  constructor() {
    super([".config", "zed"]);
  }

  readonly name = "Zed";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: false,
    postToolUse: false,
    preCompact: false,
    sessionStart: false,
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: false,
  };

  // ── Input parsing ──────────────────────────────────────
  // Zed does not support hooks. These methods exist to satisfy the
  // interface contract but will throw if called.

  parsePreToolUseInput(_raw: unknown): PreToolUseEvent {
    throw new Error("Zed does not support hooks");
  }

  parsePostToolUseInput(_raw: unknown): PostToolUseEvent {
    throw new Error("Zed does not support hooks");
  }

  parsePreCompactInput(_raw: unknown): PreCompactEvent {
    throw new Error("Zed does not support hooks");
  }

  parseSessionStartInput(_raw: unknown): SessionStartEvent {
    throw new Error("Zed does not support hooks");
  }

  // ── Response formatting ────────────────────────────────
  // Zed does not support hooks. Return undefined for all responses.

  formatPreToolUseResponse(_response: PreToolUseResponse): unknown {
    return undefined;
  }

  formatPostToolUseResponse(_response: PostToolUseResponse): unknown {
    return undefined;
  }

  formatPreCompactResponse(_response: PreCompactResponse): unknown {
    return undefined;
  }

  formatSessionStartResponse(_response: SessionStartResponse): unknown {
    return undefined;
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    return resolve(homedir(), ".config", "zed", "settings.json");
  }

  getInstructionFiles(): string[] {
    return ["AGENTS.md"];
  }

  generateHookConfig(_pluginRoot: string): HookRegistration {
    // Zed does not support hooks — return empty registration
    return {};
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

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    return [
      {
        check: "Hook support",
        status: "warn",
        message:
          "Zed does not support hooks. Only MCP integration is available.",
      },
    ];
  }

  checkPluginRegistration(): DiagnosticResult {
    // Check for context-mode in context_servers section of settings.json
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      const settings = JSON.parse(raw);
      const hasContextServers = settings.context_servers !== undefined;
      const hasContextMode = raw.includes("context-mode");

      if (hasContextServers && hasContextMode) {
        return {
          check: "MCP registration",
          status: "pass",
          message: "context-mode found in context_servers config",
        };
      }

      if (hasContextServers) {
        return {
          check: "MCP registration",
          status: "fail",
          message:
            "context_servers section exists but context-mode not found",
          fix: 'Add context-mode to context_servers in ~/.config/zed/settings.json',
        };
      }

      return {
        check: "MCP registration",
        status: "fail",
        message: "No context_servers section in settings.json",
        fix: 'Add context_servers.context-mode to ~/.config/zed/settings.json',
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: "Could not read ~/.config/zed/settings.json",
      };
    }
  }

  getInstalledVersion(): string {
    // Zed has no marketplace or plugin system for context-mode
    return "not installed";
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(_pluginRoot: string): string[] {
    // Zed does not support hooks — nothing to configure
    return [];
  }


  setHookPermissions(_pluginRoot: string): string[] {
    // No hook scripts for Zed
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // Zed has no plugin registry
  }

  getRoutingInstructions(): string {
    const instructionsPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "configs",
      "zed",
      "AGENTS.md",
    );
    try {
      return readFileSync(instructionsPath, "utf-8");
    } catch {
      // Fallback inline instructions
      return "# context-mode\n\nUse context-mode MCP tools (execute, execute_file, batch_execute, fetch_and_index, search) instead of bash/cat/curl for data-heavy operations.";
    }
  }
}
