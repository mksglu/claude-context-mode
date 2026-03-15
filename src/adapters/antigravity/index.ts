/**
 * adapters/antigravity — Antigravity platform adapter.
 *
 * Implements HookAdapter for Antigravity's MCP-only paradigm.
 *
 * Antigravity specifics:
 *   - NO hook support (standalone Electron IDE, no public plugin API)
 *   - No hook injection points in the daemon process
 *   - Config: ~/.gemini/antigravity/mcp_config.json (JSON format)
 *   - MCP: full support via mcpServers in mcp_config.json
 *   - All capabilities are false — MCP is the only integration path
 *   - Session dir: ~/.gemini/antigravity/context-mode/sessions/
 *   - Detection: ~/.gemini/antigravity/ directory + Antigravity daemon process
 */

import { createHash } from "node:crypto";
import {
    readFileSync,
    writeFileSync,
    mkdirSync,
    copyFileSync,
    accessSync,
    constants,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

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

    getSessionDir(): string {
        const dir = join(homedir(), ".gemini", "antigravity", "context-mode", "sessions");
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
        // Antigravity does not support hooks — return empty registration
        return {};
    }

    readSettings(): Record<string, unknown> | null {
        try {
            const raw = readFileSync(this.getSettingsPath(), "utf-8");
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return null;
        }
    }

    writeSettings(settings: Record<string, unknown>): void {
        const dir = resolve(homedir(), ".gemini", "antigravity");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            this.getSettingsPath(),
            JSON.stringify(settings, null, 2) + "\n",
            "utf-8",
        );
    }

    // ── Diagnostics (doctor) ─────────────────────────────────

    validateHooks(_pluginRoot: string): DiagnosticResult[] {
        return [
            {
                check: "Hook support",
                status: "warn",
                message:
                    "Antigravity does not support hooks (standalone Electron IDE, no public plugin API). " +
                    "Only MCP integration is available. Routing instructions provide ~60% compliance.",
            },
        ];
    }

    checkPluginRegistration(): DiagnosticResult {
        // Check for context-mode in mcpServers section of mcp_config.json
        try {
            const settings = this.readSettings();
            if (!settings) {
                return {
                    check: "MCP registration",
                    status: "warn",
                    message: "Could not read ~/.gemini/antigravity/mcp_config.json",
                };
            }

            const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
            if (mcpServers && "context-mode" in mcpServers) {
                return {
                    check: "MCP registration",
                    status: "pass",
                    message: "context-mode found in mcpServers config",
                };
            }

            if (mcpServers) {
                return {
                    check: "MCP registration",
                    status: "fail",
                    message: "mcpServers section exists but context-mode not found",
                    fix: "Add context-mode to mcpServers in ~/.gemini/antigravity/mcp_config.json",
                };
            }

            return {
                check: "MCP registration",
                status: "fail",
                message: "No mcpServers section in mcp_config.json",
                fix: "Add mcpServers.context-mode to ~/.gemini/antigravity/mcp_config.json",
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
        // Antigravity has no marketplace or plugin system
        return "not installed";
    }

    // ── Upgrade ────────────────────────────────────────────

    configureAllHooks(_pluginRoot: string): string[] {
        // Antigravity does not support hooks — nothing to configure
        return [];
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
        // No hook scripts for Antigravity
        return [];
    }

    updatePluginRegistry(_pluginRoot: string, _version: string): void {
        // Antigravity has no plugin registry
    }

    // ── Routing Instructions (soft enforcement) ────────────

    getRoutingInstructionsConfig(): RoutingInstructionsConfig {
        return {
            fileName: "ANTIGRAVITY.md",
            globalPath: resolve(homedir(), ".gemini", "antigravity", "ANTIGRAVITY.md"),
            projectRelativePath: "ANTIGRAVITY.md",
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

    getRoutingInstructions(): string {
        const instructionsPath = resolve(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "..",
            "..",
            "configs",
            "antigravity",
            "ANTIGRAVITY.md",
        );
        try {
            return readFileSync(instructionsPath, "utf-8");
        } catch {
            // Fallback inline instructions
            return "# context-mode\n\nUse context-mode MCP tools (execute, execute_file, batch_execute, fetch_and_index, search) instead of bash/cat/curl for data-heavy operations.";
        }
    }
}
