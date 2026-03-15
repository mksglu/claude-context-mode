/**
 * adapters/antigravity — Google Antigravity platform adapter.
 *
 * Implements HookAdapter for Antigravity's current MCP + workflow paradigm.
 *
 * Antigravity specifics:
 *   - No native pre/post tool hooks yet
 *   - MCP registration lives in ~/.gemini/antigravity/mcp_config.json
 *   - Project workflows live under .agent/workflows/
 *   - Project routing instructions live in GEMINI.md
 *   - Session/runtime artifacts live under ~/.gemini/antigravity/
 *   - Because hooks are unavailable, enforcement is soft (workflow + GEMINI.md)
 */

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  accessSync,
  existsSync,
  constants,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
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
  RoutingInstructionsConfig,
} from "../types.js";

const WORKFLOW_FILE_NAME = "context-mode.md";

type MCPSettings = Record<string, unknown> & {
  mcpServers?: Record<string, unknown>;
  servers?: Record<string, unknown>;
};

function getAntigravityHome(): string {
  return process.env.ANTIGRAVITY_HOME
    ?? process.env.HOME
    ?? process.env.USERPROFILE
    ?? homedir();
}

export class AntigravityAdapter implements HookAdapter {
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

  parsePreToolUseInput(_raw: unknown): PreToolUseEvent {
    throw new Error("Antigravity does not support native hooks");
  }

  parsePostToolUseInput(_raw: unknown): PostToolUseEvent {
    throw new Error("Antigravity does not support native hooks");
  }

  parsePreCompactInput(_raw: unknown): PreCompactEvent {
    throw new Error("Antigravity does not support native hooks");
  }

  parseSessionStartInput(_raw: unknown): SessionStartEvent {
    throw new Error("Antigravity does not support native hooks");
  }

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

  getSettingsPath(): string {
    return resolve(getAntigravityHome(), ".gemini", "antigravity", "mcp_config.json");
  }

  getSessionDir(): string {
    const dir = join(
      getAntigravityHome(),
      ".gemini",
      "antigravity",
      "context-mode",
      "sessions",
    );
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

  generateHookConfig(_pluginRoot: string): HookRegistration {
    return {};
  }

  readSettings(): Record<string, unknown> | null {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      if (!raw.trim()) return {};
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  writeSettings(settings: Record<string, unknown>): void {
    const settingsPath = this.getSettingsPath();
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(settings, null, 2) + "\n",
      "utf-8",
    );
  }

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];

    const workflowPath = this.getWorkflowPath(process.cwd());
    if (existsSync(workflowPath)) {
      results.push({
        check: "Workflow file",
        status: "pass",
        message: `Workflow present at ${workflowPath}`,
      });
    } else {
      results.push({
        check: "Workflow file",
        status: "fail",
        message: `Missing ${workflowPath}`,
        fix: "context-mode upgrade",
      });
    }

    results.push(this.checkPluginRegistration());

    results.push({
      check: "Hook support",
      status: "warn",
      message:
        "Antigravity has no native pre/post tool hooks yet; routing is enforced via MCP, GEMINI.md, and project workflows.",
    });

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    const settings = this.readSettings();
    if (settings === null) {
      return {
        check: "MCP registration",
        status: "warn",
        message: "Could not read ~/.gemini/antigravity/mcp_config.json",
      };
    }

    if (this.hasContextModeServer(settings)) {
      return {
        check: "MCP registration",
        status: "pass",
        message: "context-mode found in Antigravity MCP config",
      };
    }

    return {
      check: "MCP registration",
      status: "fail",
      message: "context-mode not found in ~/.gemini/antigravity/mcp_config.json",
      fix: "context-mode upgrade",
    };
  }

  getInstalledVersion(): string {
    return "not installed";
  }

  configureAllHooks(pluginRoot: string): string[] {
    const changes: string[] = [];
    const settings = this.ensureContextModeServer((this.readSettings() ?? {}) as MCPSettings);
    this.writeSettings(settings.settings);
    changes.push(settings.changed ? "Added context-mode to mcp_config.json" : "context-mode already present in mcp_config.json");

    const workflowPath = this.writeWorkflowTemplate(process.cwd(), pluginRoot);
    if (workflowPath) {
      changes.push(`Wrote workflow template to ${workflowPath}`);
    } else {
      changes.push("Workflow template already present");
    }

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

  setHookPermissions(_pluginRoot: string): string[] {
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // Antigravity does not expose a separate plugin registry today.
  }

  getRoutingInstructionsConfig(): RoutingInstructionsConfig {
    return {
      fileName: "GEMINI.md",
      globalPath: resolve(getAntigravityHome(), ".gemini", "GEMINI.md"),
      projectRelativePath: "GEMINI.md",
    };
  }

  writeRoutingInstructions(projectDir: string, pluginRoot: string): string | null {
    const config = this.getRoutingInstructionsConfig();
    const targetPath = resolve(projectDir, config.projectRelativePath);
    const sourcePath = resolve(pluginRoot, "configs", "antigravity", config.fileName);

    try {
      const content = readFileSync(sourcePath, "utf-8");

      try {
        const existing = readFileSync(targetPath, "utf-8");
        if (existing.includes("context-mode")) return null;
        writeFileSync(targetPath, existing.trimEnd() + "\n\n" + content, "utf-8");
        return targetPath;
      } catch {
        writeFileSync(targetPath, content, "utf-8");
        return targetPath;
      }
    } catch {
      return null;
    }
  }

  private hasContextModeServer(settings: Record<string, unknown>): boolean {
    const mcpServers = settings.mcpServers;
    if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
      return Object.keys(mcpServers).some((key) => key === "context-mode");
    }

    const servers = settings.servers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      return Object.keys(servers).some((key) => key === "context-mode");
    }

    return false;
  }

  private ensureContextModeServer(settings: MCPSettings): {
    settings: MCPSettings;
    changed: boolean;
  } {
    const normalized: MCPSettings = { ...settings };
    const targetKey =
      normalized.mcpServers && typeof normalized.mcpServers === "object" && !Array.isArray(normalized.mcpServers)
        ? "mcpServers"
        : normalized.servers && typeof normalized.servers === "object" && !Array.isArray(normalized.servers)
          ? "servers"
          : "mcpServers";

    const servers = {
      ...((normalized[targetKey] as Record<string, unknown> | undefined) ?? {}),
    };
    const existing = servers["context-mode"] as Record<string, unknown> | undefined;
    const desired = {
      ...(existing ?? {}),
      command: "context-mode",
    };

    const changed = JSON.stringify(existing ?? null) !== JSON.stringify(desired);
    servers["context-mode"] = desired;
    normalized[targetKey] = servers;
    return { settings: normalized, changed };
  }

  private getWorkflowPath(projectDir: string): string {
    return resolve(projectDir, ".agent", "workflows", WORKFLOW_FILE_NAME);
  }

  private writeWorkflowTemplate(projectDir: string, pluginRoot: string): string | null {
    const sourcePath = resolve(pluginRoot, "configs", "antigravity", WORKFLOW_FILE_NAME);
    const targetPath = this.getWorkflowPath(projectDir);

    try {
      const content = readFileSync(sourcePath, "utf-8");
      mkdirSync(dirname(targetPath), { recursive: true });

      if (existsSync(targetPath)) {
        const existing = readFileSync(targetPath, "utf-8");
        if (existing.includes("context-mode")) return null;
        writeFileSync(targetPath, existing.trimEnd() + "\n\n" + content, "utf-8");
        return targetPath;
      }

      writeFileSync(targetPath, content, "utf-8");
      return targetPath;
    } catch {
      return null;
    }
  }
}
