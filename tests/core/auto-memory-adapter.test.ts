import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchAutoMemory } from "../../src/search/auto-memory.js";
import { CodexAdapter } from "../../src/adapters/codex/index.js";
import { GeminiCLIAdapter } from "../../src/adapters/gemini-cli/index.js";

/**
 * Slice 4 — searchAutoMemory accepts an adapter and uses its
 * getInstructionFiles() / getMemoryDir() / getConfigDir() instead of
 * hardcoded ~/.claude / CLAUDE.md.
 *
 * Without an adapter it falls back to the historical Claude defaults
 * (so existing call sites keep working).
 */

describe("searchAutoMemory adapter dispatch", () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxam-proj-"));
    configDir = mkdtempSync(join(tmpdir(), "ctxam-cfg-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it("uses adapter.getInstructionFiles() to discover project rule files", () => {
    // Codex declares ['AGENTS.md', 'AGENTS.override.md'].
    writeFileSync(
      join(projectDir, "AGENTS.md"),
      "# Codex Agent Rules\nUse exact terms like ALPHA-CODEX-MARKER everywhere.\n",
      "utf-8",
    );
    const adapter = new CodexAdapter();

    const results = searchAutoMemory(
      ["ALPHA-CODEX-MARKER"],
      5,
      projectDir,
      undefined,
      adapter,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toContain("AGENTS.md");
  });

  it("uses adapter.getMemoryDir() (e.g. ~/.codex/memories) for memory scan", () => {
    // Build a fake codex config with memories/ subdir.
    const fakeMemoriesDir = join(configDir, "memories");
    mkdirSync(fakeMemoriesDir, { recursive: true });
    writeFileSync(
      join(fakeMemoriesDir, "decisions.md"),
      "Always prefer the BETA-MEMORY-TOKEN approach.\n",
      "utf-8",
    );

    // Custom adapter overriding getConfigDir + getMemoryDir to point at fixture.
    const adapter = new CodexAdapter();
    (adapter as unknown as { getConfigDir(): string }).getConfigDir = () => configDir;
    (adapter as unknown as { getMemoryDir(): string }).getMemoryDir = () => fakeMemoriesDir;
    (adapter as unknown as { getInstructionFiles(): string[] }).getInstructionFiles = () => ["AGENTS.md"];

    const results = searchAutoMemory(
      ["BETA-MEMORY-TOKEN"],
      5,
      projectDir,
      undefined,
      adapter,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toContain("decisions.md");
  });

  it("falls back to CLAUDE.md scan when no adapter is provided", () => {
    writeFileSync(
      join(projectDir, "CLAUDE.md"),
      "Project notes mention GAMMA-FALLBACK-FLAG repeatedly.\n",
      "utf-8",
    );

    const results = searchAutoMemory(["GAMMA-FALLBACK-FLAG"], 5, projectDir);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("project/CLAUDE.md");
  });

  it("scans multiple instruction files when adapter declares multiple (e.g. AGENTS.md + AGENTS.override.md)", () => {
    writeFileSync(
      join(projectDir, "AGENTS.override.md"),
      "Override note: DELTA-OVERRIDE-MARKER takes precedence.\n",
      "utf-8",
    );
    const adapter = new CodexAdapter();

    const results = searchAutoMemory(
      ["DELTA-OVERRIDE-MARKER"],
      5,
      projectDir,
      undefined,
      adapter,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toContain("AGENTS.override.md");
  });

  it("uses Gemini convention (GEMINI.md) when GeminiCLIAdapter is supplied", () => {
    writeFileSync(
      join(projectDir, "GEMINI.md"),
      "Gemini rules: invoke EPSILON-GEMINI-FLAG on every read.\n",
      "utf-8",
    );

    const results = searchAutoMemory(
      ["EPSILON-GEMINI-FLAG"],
      5,
      projectDir,
      undefined,
      new GeminiCLIAdapter(),
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toContain("GEMINI.md");
  });
});
