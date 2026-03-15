/**
 * TDD tests for writeRoutingInstructions() auto-write at MCP server startup.
 *
 * Feature: hookless platforms receive routing instructions via the
 * project-level file their host actually reads.
 *
 * Tests written BEFORE implementation (TDD).
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ──────────────────────────────────────────────

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ctx-test-${prefix}-`));
}

function createPluginRoot(base: string): string {
  // Simulate a plugin root with configs for hookless adapters.
  const pluginRoot = join(base, "plugin");
  const codexConfigDir = join(pluginRoot, "configs", "codex");
  const antigravityConfigDir = join(pluginRoot, "configs", "antigravity");
  mkdirSync(codexConfigDir, { recursive: true });
  mkdirSync(antigravityConfigDir, { recursive: true });
  writeFileSync(
    join(codexConfigDir, "AGENTS.md"),
    "# context-mode — MANDATORY routing rules\n\nUse context-mode MCP tools.\n",
    "utf-8",
  );
  writeFileSync(
    join(antigravityConfigDir, "GEMINI.md"),
    "# context-mode — MANDATORY routing rules\n\nUse context-mode MCP tools.\n",
    "utf-8",
  );
  return pluginRoot;
}

// ── Tests ────────────────────────────────────────────────

describe("Routing instructions — platform capabilities", () => {
  test("Codex CLI has sessionStart === false (hookless)", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("codex");
    expect(adapter.capabilities.sessionStart).toBe(false);
  });

  test("Claude Code has sessionStart === true (has hooks)", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("claude-code");
    expect(adapter.capabilities.sessionStart).toBe(true);
  });

  test("Gemini CLI has sessionStart === true (has hooks)", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("gemini-cli");
    expect(adapter.capabilities.sessionStart).toBe(true);
  });

  test("Antigravity has sessionStart === false (workflow + GEMINI only)", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("antigravity");
    expect(adapter.capabilities.sessionStart).toBe(false);
  });

  test("OpenCode has sessionStart === true (has hooks)", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("opencode");
    expect(adapter.capabilities.sessionStart).toBe(true);
  });

  test("VS Code Copilot has sessionStart === true (has hooks)", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("vscode-copilot");
    expect(adapter.capabilities.sessionStart).toBe(true);
  });
});

describe("Routing instructions — writeRoutingInstructions()", () => {
  let tempDir: string;
  let projectDir: string;
  let pluginRoot: string;

  beforeEach(() => {
    tempDir = createTempDir("routing");
    projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    pluginRoot = createPluginRoot(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates AGENTS.md when file does not exist", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("codex");

    const result = adapter.writeRoutingInstructions(projectDir, pluginRoot);
    const targetPath = resolve(projectDir, "AGENTS.md");

    expect(result).toBe(targetPath);
    expect(existsSync(targetPath)).toBe(true);

    const content = readFileSync(targetPath, "utf-8");
    expect(content).toContain("context-mode");
  });

  test("appends to existing AGENTS.md that does not contain context-mode", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("codex");

    // Pre-create AGENTS.md with unrelated content
    const targetPath = resolve(projectDir, "AGENTS.md");
    const existingContent = "# My Project Agents\n\nSome existing rules.\n";
    writeFileSync(targetPath, existingContent, "utf-8");

    const result = adapter.writeRoutingInstructions(projectDir, pluginRoot);

    expect(result).toBe(targetPath);

    const content = readFileSync(targetPath, "utf-8");
    // Should preserve original content
    expect(content).toContain("My Project Agents");
    expect(content).toContain("Some existing rules.");
    // Should append context-mode instructions
    expect(content).toContain("context-mode");
  });

  test("skips when AGENTS.md already contains context-mode (idempotent)", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("codex");

    // Pre-create AGENTS.md WITH context-mode content
    const targetPath = resolve(projectDir, "AGENTS.md");
    const existingContent = "# context-mode routing\n\nAlready configured.\n";
    writeFileSync(targetPath, existingContent, "utf-8");

    const result = adapter.writeRoutingInstructions(projectDir, pluginRoot);

    // Should return null (no-op)
    expect(result).toBeNull();

    // Content should be unchanged
    const content = readFileSync(targetPath, "utf-8");
    expect(content).toBe(existingContent);
  });

  test("double-write is idempotent", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("codex");

    // First write — creates
    const result1 = adapter.writeRoutingInstructions(projectDir, pluginRoot);
    expect(result1).not.toBeNull();

    const contentAfterFirst = readFileSync(resolve(projectDir, "AGENTS.md"), "utf-8");

    // Second write — should be no-op
    const result2 = adapter.writeRoutingInstructions(projectDir, pluginRoot);
    expect(result2).toBeNull();

    const contentAfterSecond = readFileSync(resolve(projectDir, "AGENTS.md"), "utf-8");
    expect(contentAfterSecond).toBe(contentAfterFirst);
  });

  test("returns null when source config file is missing", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("codex");

    // Use a plugin root WITHOUT configs/codex/AGENTS.md
    const emptyPluginRoot = join(tempDir, "empty-plugin");
    mkdirSync(emptyPluginRoot, { recursive: true });

    const result = adapter.writeRoutingInstructions(projectDir, emptyPluginRoot);
    expect(result).toBeNull();
    expect(existsSync(resolve(projectDir, "AGENTS.md"))).toBe(false);
  });
});

describe("Routing instructions — hookless platform gate", () => {
  /**
   * Integration test: verifies that the startup logic only triggers
   * writeRoutingInstructions for platforms where sessionStart === false.
   *
   * This simulates the server.ts startup flow:
   *   const adapter = await getAdapter(platform);
   *   if (!adapter.capabilities.sessionStart) {
   *     adapter.writeRoutingInstructions(projectDir, pluginRoot);
   *   }
   */

  let tempDir: string;
  let projectDir: string;
  let pluginRoot: string;

  beforeEach(() => {
    tempDir = createTempDir("gate");
    projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    pluginRoot = createPluginRoot(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("hookless platform (codex) triggers writeRoutingInstructions", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("codex");

    // Simulate startup gate
    if (!adapter.capabilities.sessionStart) {
      adapter.writeRoutingInstructions(projectDir, pluginRoot);
    }

    expect(existsSync(resolve(projectDir, "AGENTS.md"))).toBe(true);
  });

  test("hookless platform (antigravity) triggers writeRoutingInstructions", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("antigravity");

    if (!adapter.capabilities.sessionStart) {
      adapter.writeRoutingInstructions(projectDir, pluginRoot);
    }

    expect(existsSync(resolve(projectDir, "GEMINI.md"))).toBe(true);
  });

  test("hook-capable platform (claude-code) does NOT trigger writeRoutingInstructions", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("claude-code");

    // Simulate startup gate
    if (!adapter.capabilities.sessionStart) {
      adapter.writeRoutingInstructions(projectDir, pluginRoot);
    }

    // AGENTS.md should NOT be created
    expect(existsSync(resolve(projectDir, "AGENTS.md"))).toBe(false);
  });

  test("hook-capable platform (gemini-cli) does NOT trigger writeRoutingInstructions", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("gemini-cli");

    if (!adapter.capabilities.sessionStart) {
      adapter.writeRoutingInstructions(projectDir, pluginRoot);
    }

    expect(existsSync(resolve(projectDir, "AGENTS.md"))).toBe(false);
  });

  test("hook-capable platform (opencode) does NOT trigger writeRoutingInstructions", async () => {
    const { getAdapter } = await import("../src/adapters/detect.js");
    const adapter = await getAdapter("opencode");

    if (!adapter.capabilities.sessionStart) {
      adapter.writeRoutingInstructions(projectDir, pluginRoot);
    }

    expect(existsSync(resolve(projectDir, "AGENTS.md"))).toBe(false);
  });
});
