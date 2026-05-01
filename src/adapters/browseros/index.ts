/**
 * adapters/browseros — BrowserOS platform adapter.
 *
 * Implements HookAdapter for BrowserOS's MCP-only paradigm.
 *
 * BrowserOS hook specifics:
 *   - NO hook support (MCP-only, same as Antigravity/Zed)
 *   - Config: ~/.config/opencode/mcp/<server-name>/mcp_config.json (JSON format)
 *   - MCP: full support via mcpServers in mcp_config.json
 *   - All capabilities are false — MCP is the only integration path
 *   - Session dir: ~/.config/opencode/context-mode/sessions/
 *   - Routing file: BROWSEROS.md
 *
 * Sources:
 *   - BrowserOS MCP config path: from OpenClaw mcpServers registration
 *   - browseros clientInfo.name: "browseros" (from OpenClaw MCP server registration)
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

export class BrowserOSAdapter extends BaseAdapter implements HookAdapter {
  constructor() {
    super([".config", "opencode", "context-mode"]);
  }

  readonly name = "BrowserOS";
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
  // BrowserOS does not support hooks. These methods exist to satisfy the
  // interface contract but will throw if called.

  parsePreToolUseInput(_raw: unknown): PreToolUseEvent {
    throw new Error("BrowserOS does not support hooks");
  }

  parsePostToolUseInput(_raw: unknown): PostToolUseEvent {
    throw new Error("BrowserOS does not support hooks");
  }

  parsePreCompactInput(_raw: unknown): PreCompactEvent {
    throw new Error("BrowserOS does not support hooks");
  }

  parseSessionStartInput(_raw: unknown): SessionStartEvent {
    throw new Error("BrowserOS does not support hooks");
  }

  // ── Response formatting ─────────────────────────────────

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
    // BrowserOS MCP config: ~/.config/opencode/mcp/<server-name>/mcp_config.json
    // We use contextplus subdir since that's what the user created for context-mode
    return resolve(homedir(), ".config", "opencode", "mcp", "contextplus", "mcp_config.json");
  }

  generateHookConfig(_pluginRoot: string): HookRegistration {
    // No hooks — MCP-only platform
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
          "BrowserOS does not support hooks. " +
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
        fix: "Add context-mode to mcpServers in ~/.config/opencode/mcp/contextplus/mcp_config.json",
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: "Could not read ~/.config/opencode/mcp/contextplus/mcp_config.json",
      };
    }
  }

  getInstalledVersion(): string {
    try {
      const pkgPath = resolve(
        homedir(),
        ".config",
        "opencode",
        "node_modules",
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
    // No hooks to configure — MCP-only
    return [];
  }

  setHookPermissions(_pluginRoot: string): string[] {
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // BrowserOS plugin registry is managed via MCP config
  }

  getRoutingInstructions(): string {
    const instructionsPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "configs",
      "browseros",
      "BROWSEROS.md",
    );
    try {
      return readFileSync(instructionsPath, "utf-8");
    } catch {
      return "# context-mode\n\nUse context-mode MCP tools (execute, execute_file, batch_execute, fetch_and_index, search) instead of run_command/view_file for data-heavy operations.";
    }
  }
}