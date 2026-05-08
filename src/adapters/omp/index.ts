/**
 * adapters/omp — Oh My Pi (OMP) platform adapter.
 *
 * Implements HookAdapter for OMP's MCP-only paradigm.
 *
 * OMP hook specifics:
 *   - NO hook support (MCP-only — OMP integrates via MCP, not stdin hooks)
 *   - Config: ~/.omp/agent/mcp_config.json (JSON format)
 *   - MCP: full support via mcpServers in mcp_config.json
 *   - All capabilities are false — MCP is the only integration path
 *   - Session dir: ~/.omp/context-mode/sessions/  (parallel to ~/.claude/, ~/.pi/)
 *   - Routing file: PI.md (OMP is Pi-compatible — same instruction filename)
 *
 * Why a dedicated adapter rather than reusing pi:
 *   OMP and Pi share a runtime surface but different storage roots
 *   (`~/.omp/agent/` vs `~/.pi/`). Without an OMP adapter, OMP users
 *   running through a Claude-installed harness silently land their
 *   context-mode data under `~/.claude/context-mode/` (issue #473).
 *
 * Sources:
 *   - OMP source: https://github.com/can1357/oh-my-pi
 *   - OMP_PROCESSING_AGENT_DIR config root override (defaults to ~/.omp/agent)
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
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

export class OMPAdapter extends BaseAdapter implements HookAdapter {
  constructor() {
    super([".omp"]);
  }

  readonly name = "OMP";
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
  // OMP does not support hooks. These methods exist to satisfy the
  // interface contract but will throw if called.

  parsePreToolUseInput(_raw: unknown): PreToolUseEvent {
    throw new Error("OMP does not support hooks");
  }

  parsePostToolUseInput(_raw: unknown): PostToolUseEvent {
    throw new Error("OMP does not support hooks");
  }

  parsePreCompactInput(_raw: unknown): PreCompactEvent {
    throw new Error("OMP does not support hooks");
  }

  parseSessionStartInput(_raw: unknown): SessionStartEvent {
    throw new Error("OMP does not support hooks");
  }

  // ── Response formatting ────────────────────────────────
  // OMP does not support hooks. Return undefined for all responses.

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

  /**
   * Resolve OMP agent root, honoring `OMP_PROCESSING_AGENT_DIR` when set
   * (the upstream OMP convention) and falling back to `~/.omp/agent`.
   */
  private getAgentDir(): string {
    return process.env.OMP_PROCESSING_AGENT_DIR
      ?? resolve(homedir(), ".omp", "agent");
  }

  getSettingsPath(): string {
    return resolve(this.getAgentDir(), "mcp_config.json");
  }

  /**
   * OMP nests its config under the agent dir. Always absolute.
   * `_projectDir` accepted for interface symmetry but unused — home-rooted.
   */
  getConfigDir(_projectDir?: string): string {
    return this.getAgentDir();
  }

  getInstructionFiles(): string[] {
    return ["PI.md"];
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
          "OMP does not support hooks. " +
          "Only MCP integration is available.",
      },
    ];
  }

  checkPluginRegistration(): DiagnosticResult {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      const config = JSON.parse(raw);
      const mcpServers = (config as { mcpServers?: Record<string, unknown> })?.mcpServers ?? {};

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
    try {
      const pkgPath = resolve(
        this.getAgentDir(),
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
    // OMP plugin registry is managed via mcp_config.json
  }

  getRoutingInstructions(): string {
    return "# context-mode\n\nUse context-mode MCP tools (execute, execute_file, batch_execute, fetch_and_index, search) instead of run_command/view_file for data-heavy operations.";
  }
}
