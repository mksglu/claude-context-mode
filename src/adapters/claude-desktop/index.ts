/**
 * adapters/claude-desktop — Anthropic Claude Desktop chat app adapter.
 *
 * Implements HookAdapter for Claude Desktop's MCP-only paradigm.
 *
 * Claude Desktop hook specifics:
 *   - NO hook support — Claude Desktop is a chat app, not a CLI with hook pipelines
 *   - MCP: full support via mcpServers in claude_desktop_config.json
 *   - All capabilities are false — MCP is the only integration path
 *   - Session dir: ~/.claude-desktop/context-mode/sessions/
 *   - Routing file: configs/claude-desktop/CLAUDE.md (manual paste into a
 *     Project's Custom Instructions; Claude Desktop has no auto-loading
 *     mechanism for project-level rules files)
 *
 * Config paths (where the user edits to register MCP servers):
 *   - macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 *   - Windows: %APPDATA%\Claude\claude_desktop_config.json
 *   - Linux:   ~/.config/Claude/claude_desktop_config.json
 *              (Anthropic does not officially ship a Linux Claude Desktop;
 *              path mirrors common XDG conventions for parity)
 *
 * Detection:
 *   - MCP clientInfo.name="claude-ai" (verified via mcp-server log handshake)
 *   - No env vars set by Claude Desktop, so clientInfo is the only signal
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform as osPlatform } from "node:os";

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

export class ClaudeDesktopAdapter extends BaseAdapter implements HookAdapter {
  constructor() {
    super([".claude-desktop"]);
  }

  readonly name = "Claude Desktop";
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
  // Claude Desktop does not support hooks. These methods exist to satisfy
  // the interface contract but will throw if called.

  parsePreToolUseInput(_raw: unknown): PreToolUseEvent {
    throw new Error("Claude Desktop does not support hooks");
  }

  parsePostToolUseInput(_raw: unknown): PostToolUseEvent {
    throw new Error("Claude Desktop does not support hooks");
  }

  parsePreCompactInput(_raw: unknown): PreCompactEvent {
    throw new Error("Claude Desktop does not support hooks");
  }

  parseSessionStartInput(_raw: unknown): SessionStartEvent {
    throw new Error("Claude Desktop does not support hooks");
  }

  // ── Response formatting ────────────────────────────────
  // Claude Desktop does not support hooks. Return undefined for all responses.

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
    const os = osPlatform();
    if (os === "win32") {
      const appData =
        process.env.APPDATA ?? resolve(homedir(), "AppData", "Roaming");
      return resolve(appData, "Claude", "claude_desktop_config.json");
    }
    if (os === "darwin") {
      return resolve(
        homedir(),
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      );
    }
    // Linux — Anthropic ships no official build; mirror XDG convention
    return resolve(
      homedir(),
      ".config",
      "Claude",
      "claude_desktop_config.json",
    );
  }

  /**
   * Claude Desktop config lives next to the settings file. Always absolute.
   * `_projectDir` accepted for interface symmetry but unused — home-rooted.
   */
  getConfigDir(_projectDir?: string): string {
    return dirname(this.getSettingsPath());
  }

  getInstructionFiles(): string[] {
    return ["CLAUDE.md"];
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
          "Claude Desktop does not support hooks. " +
          "Only MCP integration is available.",
      },
    ];
  }

  checkPluginRegistration(): DiagnosticResult {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      const config = JSON.parse(raw);
      const mcpServers =
        (config?.mcpServers as Record<string, unknown> | undefined) ?? {};

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
        fix: `Add context-mode to mcpServers in ${this.getSettingsPath()}`,
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
    // Claude Desktop installs context-mode via npm (global or npx) — the
    // adapter cannot reliably locate the installed package.json from the
    // host's perspective. Defer to the running process version instead.
    try {
      const pkgPath = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
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
    // Claude Desktop plugin registry is managed via claude_desktop_config.json
  }

  getRoutingInstructions(): string {
    const instructionsPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "configs",
      "claude-desktop",
      "CLAUDE.md",
    );
    try {
      return readFileSync(instructionsPath, "utf-8");
    } catch {
      return "# context-mode\n\nUse context-mode MCP tools (ctx_execute, ctx_execute_file, ctx_batch_execute, ctx_fetch_and_index, ctx_search) instead of raw Bash/Read/WebFetch for data-heavy operations.";
    }
  }
}
