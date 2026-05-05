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
import { fileURLToPath } from "node:url";

// ── Test harness script ──
// Replicates ensure-deps.mjs logic but captures commands instead of executing.
const HARNESS = `
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.argv[2];
const NATIVE_DEPS = ["better-sqlite3"];
const NATIVE_BINARIES = {
  "better-sqlite3": ["build", "Release", "better_sqlite3.node"],
};
const captured = [];

for (const pkg of NATIVE_DEPS) {
  const pkgDir = resolve(root, "node_modules", pkg);
  const binaryPath = resolve(pkgDir, ...NATIVE_BINARIES[pkg]);
  if (!existsSync(pkgDir)) {
    captured.push("install:" + pkg);
  } else if (!existsSync(binaryPath)) {
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
    timeout: 30_000,
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
    // Simulate ignore-scripts=true: directory exists, no native binary
    mkdirSync(join(root, "node_modules", "better-sqlite3"), { recursive: true });
    const commands = runHarness(root);
    expect(commands).toEqual(["rebuild:better-sqlite3"]);
  });

  test("runs npm rebuild when build/Release exists but native binary is missing", () => {
    const root = createTempRoot();
    mkdirSync(join(root, "node_modules", "better-sqlite3", "build", "Release"), { recursive: true });
    const commands = runHarness(root);
    expect(commands).toEqual(["rebuild:better-sqlite3"]);
  });

  test("runs npm rebuild when prebuilds exists but native binary is missing", () => {
    const root = createTempRoot();
    mkdirSync(join(root, "node_modules", "better-sqlite3", "prebuilds"), { recursive: true });
    const commands = runHarness(root);
    expect(commands).toEqual(["rebuild:better-sqlite3"]);
  });

  test("skips when actual native binary exists", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "native-binary");
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

// ── Shared path to the real ensure-deps.mjs (used by ABI + codesign tests) ──
const ensureDepsAbsPath = join(fileURLToPath(import.meta.url), "..", "..", "..", "hooks", "ensure-deps.mjs");

// ═══════════════════════════════════════════════════════════════════════
// RED-GREEN tests for ABI cache validation (#148 follow-up)
// ═══════════════════════════════════════════════════════════════════════

// Subprocess harness that replicates ensureNativeCompat's decision logic
// using a simulated probe (binary is "valid" if content starts with "VALID").
// This avoids needing a real better-sqlite3 install in the temp dir.
const ABI_HARNESS = `
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pluginRoot = process.argv[2];
const abi = "137"; // arbitrary ABI value for testing — not tied to any real Node version
const captured = [];

const nativeDir = resolve(pluginRoot, "node_modules", "better-sqlite3", "build", "Release");
const binaryPath = resolve(nativeDir, "better_sqlite3.node");
const abiCachePath = resolve(nativeDir, "better_sqlite3.abi" + abi + ".node");

function probeNative() {
  if (!existsSync(binaryPath)) return false;
  const buf = readFileSync(binaryPath);
  return buf.length >= 5 && buf.toString("utf-8", 0, 5) === "VALID";
}

if (!existsSync(nativeDir)) {
  console.log(JSON.stringify(captured));
  process.exit(0);
}

if (existsSync(abiCachePath)) {
  copyFileSync(abiCachePath, binaryPath);
  captured.push("cache-swap");
  if (probeNative()) {
    captured.push("cache-valid");
    console.log(JSON.stringify(captured));
    process.exit(0);
  }
  captured.push("cache-invalid");
}

if (existsSync(binaryPath) && probeNative()) {
  captured.push("probe-ok");
  copyFileSync(binaryPath, abiCachePath);
  captured.push("cached");
} else {
  captured.push(existsSync(binaryPath) ? "probe-fail" : "binary-missing");
  writeFileSync(binaryPath, "VALID-rebuilt-binary");
  captured.push("rebuilt");
  if (probeNative()) {
    copyFileSync(binaryPath, abiCachePath);
    captured.push("cached");
  }
}

console.log(JSON.stringify(captured));
`;

describe("ensure-deps: ABI cache validation (#148 follow-up)", () => {
  function runAbiHarness(root: string): string[] {
    const harnessPath = join(root, "_abi-harness.mjs");
    writeFileSync(harnessPath, ABI_HARNESS, "utf-8");
    const result = spawnSync("node", [harnessPath, root], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    return JSON.parse(result.stdout.trim());
  }

  test("corrupted ABI cache: detects invalid binary, rebuilds, and re-caches", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    // Valid binary on disk
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "VALID-original");
    // Corrupted cache (wrong ABI binary saved under current ABI label)
    writeFileSync(join(releaseDir, "better_sqlite3.abi137.node"), "WRONG-abi115-binary");

    const actions = runAbiHarness(root);
    expect(actions).toEqual(["cache-swap", "cache-invalid", "probe-fail", "rebuilt", "cached"]);
  });

  test("valid ABI cache: uses fast path without rebuild", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "VALID-original");
    writeFileSync(join(releaseDir, "better_sqlite3.abi137.node"), "VALID-cached-binary");

    const actions = runAbiHarness(root);
    expect(actions).toEqual(["cache-swap", "cache-valid"]);
  });

  test("missing ABI cache with valid binary: probes and creates cache", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "VALID-original");
    // No abi137.node cache file

    const actions = runAbiHarness(root);
    expect(actions).toEqual(["probe-ok", "cached"]);
  });

  test("missing native binary in existing native dir: rebuilds and caches", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    // No better_sqlite3.node on disk and no cache file

    const actions = runAbiHarness(root);
    expect(actions).toEqual(["binary-missing", "rebuilt", "cached"]);
  });

  test("missing ABI cache with incompatible binary: rebuilds and caches", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "WRONG-different-abi");
    // No cache file

    const actions = runAbiHarness(root);
    expect(actions).toEqual(["probe-fail", "rebuilt", "cached"]);
  });

  test("corrupted cache with missing binary: early return after cache swap fails", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    // No better_sqlite3.node on disk, only a corrupted cache
    writeFileSync(join(releaseDir, "better_sqlite3.abi137.node"), "WRONG-corrupt");

    const actions = runAbiHarness(root);
    // Cache swap copies corrupt → binaryPath, probe fails, then falls through.
    // binaryPath now exists (from the copy), so it won't hit the early return.
    // Instead it probes again, fails, and rebuilds.
    expect(actions).toEqual(["cache-swap", "cache-invalid", "probe-fail", "rebuilt", "cached"]);
  });

  test("graceful degradation: does not throw when probe and rebuild both fail", () => {
    // Exercise the real ensureNativeCompat on a fake plugin root where
    // better-sqlite3 exists but has no valid binary and npm rebuild will fail.
    // The outer try/catch must swallow all errors.
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "CORRUPT-binary");

    const harness = `
import { ensureNativeCompat } from ${JSON.stringify("file://" + ensureDepsAbsPath.replace(/\\/g, "/"))};
try {
  ensureNativeCompat(${JSON.stringify(root)});
  console.log(JSON.stringify({ threw: false }));
} catch (e) {
  console.log(JSON.stringify({ threw: true, error: e.message }));
}
`;
    const harnessPath = join(root, "_degrade-harness.mjs");
    writeFileSync(harnessPath, harness, "utf-8");
    const result = spawnSync("node", [harnessPath], {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: join(fileURLToPath(import.meta.url), "..", ".."),
    });
    if (result.error) throw result.error;
    const out = JSON.parse(result.stdout.trim());
    expect(out).toEqual({ threw: false });
  });

  test("graceful degradation: missing native binary rebuild failure does not throw", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    // No better_sqlite3.node — binary missing, rebuild will also fail

    const harness = `
import { ensureNativeCompat } from ${JSON.stringify("file://" + ensureDepsAbsPath.replace(/\\/g, "/"))};
try {
  ensureNativeCompat(${JSON.stringify(root)});
  console.log(JSON.stringify({ threw: false }));
} catch (e) {
  console.log(JSON.stringify({ threw: true, error: e.message }));
}
`;
    const harnessPath = join(root, "_missing-binary-degrade-harness.mjs");
    writeFileSync(harnessPath, harness, "utf-8");
    const result = spawnSync("node", [harnessPath], {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: join(fileURLToPath(import.meta.url), "..", ".."),
    });
    if (result.error) throw result.error;
    const out = JSON.parse(result.stdout.trim());
    expect(out).toEqual({ threw: false });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// RED-GREEN tests for macOS codesign after binary copy (#SIGKILL fix)
// ═══════════════════════════════════════════════════════════════════════

// Subprocess harness that imports codesignBinary from ensure-deps.mjs and
// exercises it with mocked execSync to verify codesign behavior.
const CODESIGN_HARNESS = `
import { codesignBinary } from ${JSON.stringify("file://" + ensureDepsAbsPath.replace(/\\/g, "/"))};

// Test: function must exist and be callable
if (typeof codesignBinary !== "function") {
  console.log(JSON.stringify({ error: "codesignBinary is not exported" }));
  process.exit(0);
}

const action = process.argv[2];
const fakePath = process.argv[3] || "/tmp/fake.node";

if (action === "check-export") {
  console.log(JSON.stringify({ exported: true }));
} else if (action === "run") {
  // Actually call codesignBinary — on macOS it will invoke codesign,
  // on non-macOS it should be a no-op. Either way it must not throw.
  try {
    codesignBinary(fakePath);
    console.log(JSON.stringify({ success: true, platform: process.platform }));
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message }));
  }
}
`;

describe("ensure-deps: codesignBinary macOS SIGKILL fix", () => {
  function runCodesignHarness(action: string, fakePath?: string): Record<string, unknown> {
    const root = createTempRoot();
    const harnessPath = join(root, "_codesign-harness.mjs");
    writeFileSync(harnessPath, CODESIGN_HARNESS, "utf-8");
    const args = [harnessPath, action];
    if (fakePath) args.push(fakePath);
    const result = spawnSync("node", args, {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: join(fileURLToPath(import.meta.url), "..", ".."),
    });
    if (result.error) throw result.error;
    const stdout = result.stdout?.trim();
    if (!stdout) {
      throw new Error(`Harness produced no output. stderr: ${result.stderr}`);
    }
    return JSON.parse(stdout);
  }

  test("Test A: codesignBinary is exported as a function", () => {
    const out = runCodesignHarness("check-export");
    expect(out).toEqual({ exported: true });
  });

  test("Test B: codesignBinary does not throw (works on any platform)", () => {
    const out = runCodesignHarness("run", "/tmp/nonexistent.node");
    expect(out).toHaveProperty("success", true);
  });

  test("Test C: codesignBinary is safe when codesign target does not exist", () => {
    // On macOS, codesign will fail on a nonexistent file — must not throw.
    // On non-macOS, it should be a no-op.
    const out = runCodesignHarness("run", "/tmp/definitely-does-not-exist-12345.node");
    expect(out).toHaveProperty("success", true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Modern SQLite skip gate (#331 — Node v24 SIGSEGV prevention)
// ═══════════════════════════════════════════════════════════════════════

describe("ensure-deps: modern SQLite skip gate (#331)", () => {
  const MODERN_SQLITE_HARNESS = `
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Replicate hasModernSqlite() logic from ensure-deps.mjs
function hasModernSqlite() {
  if (typeof globalThis.Bun !== "undefined") return true;
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

const root = process.argv[2];
const result = {
  hasModernSqlite: hasModernSqlite(),
  nodeVersion: process.versions.node,
};

// If modern SQLite, ensureDeps and ensureNativeCompat should be no-ops.
// Verify by checking that no npm commands would be attempted.
if (result.hasModernSqlite) {
  // Simulate: even if node_modules is missing, ensureDeps should skip
  const pkgDir = resolve(root, "node_modules", "better-sqlite3");
  result.pkgDirExists = existsSync(pkgDir);
  result.wouldSkip = true;
} else {
  result.wouldSkip = false;
}

console.log(JSON.stringify(result));
`;

  test("hasModernSqlite returns correct value for current Node version", () => {
    const root = createTempRoot();
    const harnessPath = join(root, "_modern-sqlite-harness.mjs");
    writeFileSync(harnessPath, MODERN_SQLITE_HARNESS, "utf-8");
    const result = spawnSync("node", [harnessPath, root], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    const out = JSON.parse(result.stdout.trim());
    const [major, minor] = process.versions.node.split(".").map(Number);
    const expected = major > 22 || (major === 22 && minor >= 5);
    expect(out.hasModernSqlite).toBe(expected);
  });

  test("ensureDeps is a no-op on modern runtimes (imports without side effects)", () => {
    // On Node >= 22.5 or Bun, importing ensure-deps.mjs should NOT attempt
    // any npm install/rebuild — the hasModernSqlite() gate early-returns.
    const [major, minor] = process.versions.node.split(".").map(Number);
    const isModern = major > 22 || (major === 22 && minor >= 5);
    if (!isModern) return; // skip on older Node

    const root = createTempRoot();
    // No node_modules at all — on old Node this would trigger npm install
    const harness = `
import ${JSON.stringify("file://" + ensureDepsAbsPath.replace(/\\/g, "/"))};
// If we got here without error, ensureDeps() and ensureNativeCompat()
// both returned early (no npm install attempted on empty dir).
console.log(JSON.stringify({ ok: true }));
`;
    const harnessPath = join(root, "_import-harness.mjs");
    writeFileSync(harnessPath, harness, "utf-8");
    const result = spawnSync("node", [harnessPath], {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: root,
    });
    if (result.error) throw result.error;
    const out = JSON.parse(result.stdout.trim());
    expect(out).toEqual({ ok: true });
  });
});

// ── better-sqlite3 binding self-heal (#408) ───────────────────────────────
//
// The missing-binding heal previously inlined ~30 lines of prebuild-install
// + npm install + stderr logic in `ensureDeps()`. PR #410 review: that
// block was a copy of the same logic in scripts/postinstall.mjs. The fix
// extracts both into scripts/heal-better-sqlite3.mjs and has each caller
// delegate. ABI-mismatch heal in ensureNativeCompat() is unrelated and
// must remain (regression-critical — guards #148, #203).

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

describe("ensure-deps: better-sqlite3 binding self-heal (#408)", () => {
  const ENSURE_DEPS_SRC = readFileSync(
    resolvePath(fileURLToPath(import.meta.url), "..", "..", "..", "hooks", "ensure-deps.mjs"),
    "utf-8",
  );

  test("references the shared heal helper at scripts/heal-better-sqlite3.mjs", () => {
    // After dedupe the inline heal is gone — replaced by a reference to
    // scripts/heal-better-sqlite3.mjs. Accept either a static import or a
    // dynamic-import path: the helper is lazy-loaded so synthetic test
    // harnesses (e.g. tests/session-hooks-smoke) that don't ship `scripts/`
    // alongside `hooks/` don't crash the hook on load.
    const referencesHelperPath =
      /["']\.\.\/scripts\/heal-better-sqlite3(?:\.mjs)?["']/.test(ENSURE_DEPS_SRC) ||
      /scripts[\\/]heal-better-sqlite3\.mjs/.test(ENSURE_DEPS_SRC) ||
      /heal-better-sqlite3\.mjs/.test(ENSURE_DEPS_SRC);
    expect(referencesHelperPath).toBe(true);
    expect(ENSURE_DEPS_SRC).toContain("healBetterSqlite3Binding");
  });

  test("calls healBetterSqlite3Binding(...) inside the missing-binding branch", () => {
    // The else-if guarding against a missing native binary must invoke the
    // shared helper (not inline its own copy).
    const anchor = ENSURE_DEPS_SRC.indexOf(
      "!existsSync(resolve(pkgDir, ...NATIVE_BINARIES[pkg]))",
    );
    expect(anchor).toBeGreaterThan(-1);
    const end = ENSURE_DEPS_SRC.indexOf("\nexport function ensureNativeCompat", anchor);
    const branch = ENSURE_DEPS_SRC.slice(anchor, end === -1 ? ENSURE_DEPS_SRC.length : end);
    expect(/healBetterSqlite3Binding\s*\(/.test(branch)).toBe(true);

    // Inline 3-layer heal must be gone — no `npm rebuild better-sqlite3`,
    // no direct `prebuild-install` resolve, no manual process.execPath
    // spawn here. The helper owns all of that now.
    expect(/\brebuild\s+better-sqlite3\b/.test(branch)).toBe(false);
    expect(/prebuild-install/.test(branch)).toBe(false);
    expect(/process\.execPath/.test(branch)).toBe(false);
  });

  test("ABI-mismatch rebuild path in ensureNativeCompat() remains intact", () => {
    // Regression guard — the ABI-mismatch heal (separate from #408's
    // missing-binding heal) MUST keep using `npm rebuild better-sqlite3
    // --ignore-scripts=false` for the cached-binary fallback flow.
    expect(
      /\brebuild\s+better-sqlite3\s+--ignore-scripts=false/.test(ENSURE_DEPS_SRC),
    ).toBe(true);
    expect(
      /export function ensureNativeCompat\s*\(/.test(ENSURE_DEPS_SRC),
    ).toBe(true);
    // The rebuild appears at least twice (skipProbe path + probe-failed path).
    const rebuildCount = (ENSURE_DEPS_SRC.match(
      /\brebuild\s+better-sqlite3\s+--ignore-scripts=false/g,
    ) || []).length;
    expect(rebuildCount).toBeGreaterThanOrEqual(2);
  });
});
