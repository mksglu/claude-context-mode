import { describe, it, expect, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AntigravityAdapter } from "../../src/adapters/antigravity/index.js";

describe("AntigravityAdapter", () => {
    let adapter: AntigravityAdapter;

    beforeEach(() => {
        adapter = new AntigravityAdapter();
    });

    // ── Identity ──────────────────────────────────────────

    describe("identity", () => {
        it("name is Antigravity", () => {
            expect(adapter.name).toBe("Antigravity");
        });

        it("paradigm is mcp-only", () => {
            expect(adapter.paradigm).toBe("mcp-only");
        });
    });

    // ── Capabilities ──────────────────────────────────────

    describe("capabilities", () => {
        it("all capabilities are false", () => {
            expect(adapter.capabilities.preToolUse).toBe(false);
            expect(adapter.capabilities.postToolUse).toBe(false);
            expect(adapter.capabilities.preCompact).toBe(false);
            expect(adapter.capabilities.sessionStart).toBe(false);
            expect(adapter.capabilities.canModifyArgs).toBe(false);
            expect(adapter.capabilities.canModifyOutput).toBe(false);
            expect(adapter.capabilities.canInjectSessionContext).toBe(false);
        });
    });

    // ── Parse methods (all throw) ─────────────────────────

    describe("parse methods", () => {
        it("parsePreToolUseInput throws", () => {
            expect(() => adapter.parsePreToolUseInput({})).toThrow(
                /Antigravity does not support hooks/,
            );
        });

        it("parsePostToolUseInput throws", () => {
            expect(() => adapter.parsePostToolUseInput({})).toThrow(
                /Antigravity does not support hooks/,
            );
        });

        it("parsePreCompactInput throws", () => {
            expect(() => adapter.parsePreCompactInput({})).toThrow(
                /Antigravity does not support hooks/,
            );
        });

        it("parseSessionStartInput throws", () => {
            expect(() => adapter.parseSessionStartInput({})).toThrow(
                /Antigravity does not support hooks/,
            );
        });
    });

    // ── Format methods (all return undefined) ─────────────

    describe("format methods", () => {
        it("formatPreToolUseResponse returns undefined", () => {
            const result = adapter.formatPreToolUseResponse({
                decision: "deny",
                reason: "test",
            });
            expect(result).toBeUndefined();
        });

        it("formatPostToolUseResponse returns undefined", () => {
            const result = adapter.formatPostToolUseResponse({
                additionalContext: "test",
            });
            expect(result).toBeUndefined();
        });

        it("formatPreCompactResponse returns undefined", () => {
            const result = adapter.formatPreCompactResponse({
                context: "test",
            });
            expect(result).toBeUndefined();
        });

        it("formatSessionStartResponse returns undefined", () => {
            const result = adapter.formatSessionStartResponse({
                context: "test",
            });
            expect(result).toBeUndefined();
        });
    });

    // ── Hook config (all empty) ───────────────────────────

    describe("hook config", () => {
        it("generateHookConfig returns empty object", () => {
            const config = adapter.generateHookConfig("/some/plugin/root");
            expect(config).toEqual({});
        });

        it("configureAllHooks returns empty array", () => {
            const changes = adapter.configureAllHooks("/some/plugin/root");
            expect(changes).toEqual([]);
        });

        it("setHookPermissions returns empty array", () => {
            const set = adapter.setHookPermissions("/some/plugin/root");
            expect(set).toEqual([]);
        });
    });

    // ── Config paths ──────────────────────────────────────

    describe("config paths", () => {
        it("settings path is ~/.gemini/antigravity/settings.json", () => {
            expect(adapter.getSettingsPath()).toBe(
                resolve(homedir(), ".gemini", "antigravity", "settings.json"),
            );
        });

        it("session dir is under ~/.gemini/antigravity/context-mode/sessions/", () => {
            const sessionDir = adapter.getSessionDir();
            expect(sessionDir).toBe(
                join(homedir(), ".gemini", "antigravity", "context-mode", "sessions"),
            );
        });

        it("session DB path is deterministic for same project dir", () => {
            const path1 = adapter.getSessionDBPath("/my/project");
            const path2 = adapter.getSessionDBPath("/my/project");
            expect(path1).toBe(path2);
            expect(path1).toMatch(/\.db$/);
        });

        it("session events path ends with -events.md", () => {
            const path = adapter.getSessionEventsPath("/my/project");
            expect(path).toMatch(/-events\.md$/);
        });
    });

    // ── Routing instructions ──────────────────────────────

    describe("routing instructions", () => {
        it("routing config uses ANTIGRAVITY.md", () => {
            const config = adapter.getRoutingInstructionsConfig();
            expect(config.fileName).toBe("ANTIGRAVITY.md");
            expect(config.projectRelativePath).toBe("ANTIGRAVITY.md");
            expect(config.globalPath).toBe(
                resolve(homedir(), ".gemini", "antigravity", "ANTIGRAVITY.md"),
            );
        });
    });

    // ── Diagnostics ───────────────────────────────────────

    describe("diagnostics", () => {
        it("validateHooks returns a warning about no hook support", () => {
            const results = adapter.validateHooks("/some/plugin/root");
            expect(results).toHaveLength(1);
            expect(results[0].status).toBe("warn");
            expect(results[0].message).toContain("does not support hooks");
        });

        it("getInstalledVersion returns 'not installed'", () => {
            expect(adapter.getInstalledVersion()).toBe("not installed");
        });
    });

    // ── Settings I/O ──────────────────────────────────────

    describe("settings", () => {
        it("readSettings returns null when file does not exist", () => {
            expect(adapter.readSettings()).toBeNull();
        });
    });
});
