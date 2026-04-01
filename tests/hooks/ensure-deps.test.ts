/**
 * ensure-deps.mjs — TDD tests for native binary detection (#206)
 *
 * Tests the detection logic that determines whether to:
 * 1. npm install (package dir missing)
 * 2. npm rebuild (package dir exists but native binary missing)
 * 3. skip (native binary already present)
 *
 * Uses subprocess pattern (like integration.test.ts) with a test harness
 * that captures commands instead of executing them.
 */

import { describe, test, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Test harness script ──
// Replicates ensure-deps.mjs logic but captures commands instead of executing.
const HARNESS = `
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.argv[2];
const NATIVE_DEPS = ["better-sqlite3"];
const captured = [];

for (const pkg of NATIVE_DEPS) {
  const pkgDir = resolve(root, "node_modules", pkg);
  if (!existsSync(pkgDir)) {
    captured.push("install:" + pkg);
  } else if (
    !existsSync(resolve(pkgDir, "build", "Release")) &&
    !existsSync(resolve(pkgDir, "prebuilds"))
  ) {
    captured.push("rebuild:" + pkg);
  }
}

console.log(JSON.stringify(captured));
`;

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* ignore */ }
  }
});

function createTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "ensure-deps-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runHarness(root: string): string[] {
  const harnessPath = join(root, "_test-harness.mjs");
  writeFileSync(harnessPath, HARNESS, "utf-8");
  const result = spawnSync("node", [harnessPath, root], {
    encoding: "utf-8",
    timeout: 5000,
  });
  return JSON.parse(result.stdout.trim());
}

// ═══════════════════════════════════════════════════════════════════════
// RED-GREEN tests for ensure-deps native binary detection
// ═══════════════════════════════════════════════════════════════════════

describe("ensure-deps: native binary detection (#206)", () => {
  test("runs npm install when package directory is missing", () => {
    const root = createTempRoot();
    // No node_modules at all
    const commands = runHarness(root);
    expect(commands).toEqual(["install:better-sqlite3"]);
  });

  test("runs npm rebuild when package dir exists but no native binary", () => {
    const root = createTempRoot();
    // Simulate ignore-scripts=true: directory exists, no build/Release or prebuilds
    mkdirSync(join(root, "node_modules", "better-sqlite3"), { recursive: true });
    const commands = runHarness(root);
    expect(commands).toEqual(["rebuild:better-sqlite3"]);
  });

  test("skips when build/Release exists", () => {
    const root = createTempRoot();
    mkdirSync(join(root, "node_modules", "better-sqlite3", "build", "Release"), { recursive: true });
    const commands = runHarness(root);
    expect(commands).toEqual([]);
  });

  test("skips when prebuilds exists", () => {
    const root = createTempRoot();
    mkdirSync(join(root, "node_modules", "better-sqlite3", "prebuilds"), { recursive: true });
    const commands = runHarness(root);
    expect(commands).toEqual([]);
  });

  test("rebuild triggers even when package.json and JS files exist", () => {
    const root = createTempRoot();
    const pkgDir = join(root, "node_modules", "better-sqlite3");
    mkdirSync(pkgDir, { recursive: true });
    // JS files exist (npm installed the package) but no native binary
    writeFileSync(join(pkgDir, "package.json"), '{"name":"better-sqlite3"}', "utf-8");
    writeFileSync(join(pkgDir, "index.js"), "module.exports = {};", "utf-8");
    const commands = runHarness(root);
    expect(commands).toEqual(["rebuild:better-sqlite3"]);
  });
});
