/**
 * adapters/antigravity — Google Antigravity platform adapter.
 *
 * Implements HookAdapter for Antigravity's MCP-only paradigm.
 *
 * Antigravity hook specifics:
 *   - NO hook support (MCP-only, same as Codex CLI)
 *   - Config: ~/.gemini/antigravity/mcp_config.json (JSON format)
 *   - MCP: full support via mcpServers in mcp_config.json
 *   - All capabilities are false — MCP is the only integration path
 *   - Session dir: ~/.gemini/context-mode/sessions/
 *   - Routing file: GEMINI.md (shared with Gemini CLI filename, different content)
 *
 * Sources:
 *   - Config path: https://github.com/google-gemini/gemini-cli/issues/16058
 *   - MCP support: https://antigravity.google/docs/mcp
 *   - Tool list: System prompt leak (21 verified tools)
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

export class AntigravityAdapter extends BaseAdapter implements HookAdapter {
  constructor() {
    super([".gemini"]);
  }

  readonly name = "Antigravity";
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
  // Antigravity does not support hooks. These methods exist to satisfy the
  // interface contract but will throw if called.

  parsePreToolUseInput(_raw: unknown): PreToolUseEvent {
    throw new Error("Antigravity does not support hooks");
  }

  parsePostToolUseInput(_raw: unknown): PostToolUseEvent {
    throw new Error("Antigravity does not support hooks");
  }

  parsePreCompactInput(_raw: unknown): PreCompactEvent {
    throw new Error("Antigravity does not support hooks");
  }

  parseSessionStartInput(_raw: unknown): SessionStartEvent {
    throw new Error("Antigravity does not support hooks");
  }

  // ── Response formatting ────────────────────────────────
  // Antigravity does not support hooks. Return undefined for all responses.

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
    return resolve(homedir(), ".gemini", "antigravity", "mcp_config.json");
  }

  generateHookConfig(_pluginRoot: string): HookRegistration {
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
          "Antigravity does not support hooks. " +
          "Only MCP integration is available.",
      },
    ];
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
        fix: "Add context-mode to mcpServers in ~/.gemini/antigravity/mcp_config.json",
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: "Could not read ~/.gemini/antigravity/mcp_config.json",
      };
    }
  }

  getInstalledVersion(): string {
    try {
      const pkgPath = resolve(
        homedir(),
        ".gemini",
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

  configureAllHooks(_pluginRoot: string): string[] {
    return [];
  }



  setHookPermissions(_pluginRoot: string): string[] {
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // Antigravity plugin registry is managed via mcp_config.json
  }

  getRoutingInstructions(): string {
    const instructionsPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "configs",
      "antigravity",
      "GEMINI.md",
    );
    try {
      return readFileSync(instructionsPath, "utf-8");
    } catch {
      return "# context-mode\n\nUse context-mode MCP tools (execute, execute_file, batch_execute, fetch_and_index, search) instead of run_command/view_file for data-heavy operations.";
    }
  }
}
