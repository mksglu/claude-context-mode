/**
 * heal-better-sqlite3.mjs source contract tests (#514, VS 2026).
 *
 * #514 — package-missing branch was a no-op that trusted ensure-deps to
 * recover. That trust broke on Node 26: ensure-deps's `npm install` also
 * silently skipped better-sqlite3 under optionalDependencies. The heal
 * script must take ownership and actively install via `npm install better-sqlite3`.
 *
 * VS 2026 — node-gyp's internal version→year map (15→2017…17→2022) does
 * not include VS 2026 (internal major 18). The fix queries vswhere's
 * `displayName` property (e.g. "Visual Studio Community 2026") and extracts
 * the 4-digit year with a regex. catalog_productLineVersion is NOT used
 * because it returns "18" on VS 2026 rather than the year string.
 *
 * @see https://github.com/mksglu/context-mode/issues/514
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HEAL_SRC = readFileSync(
  resolve(import.meta.dirname, "../../scripts/heal-better-sqlite3.mjs"),
  "utf-8",
);

describe("heal-better-sqlite3.mjs — package-missing branch (#514)", () => {
  it("does NOT short-circuit with healed:false on package-missing", () => {
    // Find the package-missing branch — it used to be the FIRST guard
    // and returned immediately. Post-fix, it must install the package
    // before returning.
    const idx = HEAL_SRC.indexOf("package-missing");
    expect(idx).toBeGreaterThan(-1);

    // Look BEFORE the "package-missing" literal for an early
    // `return { healed: false` — that was the no-op pattern.
    const preamble = HEAL_SRC.slice(0, idx);
    // The function must not contain a guard that returns healed:false
    // immediately on bsqRoot missing. Specifically: there must NOT be
    // an `if (!existsSync(bsqRoot)) return { healed: false ... }` block
    // that does no install work first.
    const earlyReturnPattern =
      /if\s*\(\s*!\s*existsSync\(\s*bsqRoot\s*\)\s*\)\s*\{\s*[^{}]*return\s*\{\s*healed:\s*false[^}]*reason:\s*["']package-missing["']/;
    expect(earlyReturnPattern.test(preamble + HEAL_SRC.slice(idx, idx + 200))).toBe(false);
  });

  it("invokes `npm install better-sqlite3` with --no-optional in the package-missing branch", () => {
    // The fix: when the package directory is missing, the heal script
    // must run `npm install better-sqlite3 --no-optional --no-save
    // --no-audit --no-fund` to actively pull the package down.
    // --no-optional defends against future regressions where someone
    // moves the dep back to optionalDependencies (npm would then try to
    // skip it again on engine mismatch — --no-optional flips the
    // include/skip decision in our favor for this targeted install).
    //
    // Implementation may use execFileSync with array args (preferred,
    // shell-injection-safe) OR a single shell-string command. Either is
    // acceptable as long as both `better-sqlite3` and `--no-optional`
    // appear in the install invocation.
    expect(HEAL_SRC).toMatch(/"better-sqlite3"|'better-sqlite3'/);
    expect(HEAL_SRC).toMatch(/"--no-optional"|'--no-optional'|--no-optional/);
    expect(HEAL_SRC).toMatch(/"install"|'install'|\bnpm\s+install\b/);
  });

  it("uses execFileSync (or spawnSync) with a timeout for the package install", () => {
    // Shell injection guard + bounded execution. execSync alone with a
    // shell:true string is the historical pattern in this file but it's
    // brittle on Windows; for the new install path we want
    // execFileSync/spawnSync semantics with an explicit timeout so a
    // hung registry call cannot freeze /ctx-upgrade indefinitely.
    expect(HEAL_SRC).toMatch(/(execFileSync|spawnSync)\s*\([^)]*better-sqlite3/s);
    // The new install branch must declare a timeout (any positive ms).
    expect(HEAL_SRC).toMatch(/timeout:\s*\d{4,}/);
  });

  it("recurses into the binding-missing path after a successful package install", () => {
    // After `npm install better-sqlite3` writes the package, the heal
    // script must continue into the existing 3-layer (prebuild-install
    // / npm install / stderr-advice) flow. We verify this contract by
    // checking that the package-missing branch ends with a re-check of
    // bindingPath (or a recursive call) rather than an immediate return.
    const idx = HEAL_SRC.indexOf("package-missing");
    const afterTag = HEAL_SRC.slice(idx, idx + 600);
    // Either a recursive `healBetterSqlite3Binding(pkgRoot)` call OR a
    // bindingPath existence re-check after install satisfies the
    // contract.
    const continuesWork =
      /healBetterSqlite3Binding\s*\(\s*pkgRoot\s*\)/.test(HEAL_SRC) ||
      /existsSync\s*\(\s*bindingPath\s*\)/.test(afterTag) ||
      /\bbindingPath\b/.test(afterTag);
    expect(continuesWork).toBe(true);
  });
});

describe("heal-better-sqlite3.mjs — Windows VS year detection (VS 2026+)", () => {
  // ── Slice 1: detectWindowsVsYear() unit tests ──────────────────────

  it("exports detectWindowsVsYear() as a function", async () => {
    const mod = await import("../../scripts/heal-better-sqlite3.mjs");
    expect(typeof mod.detectWindowsVsYear).toBe("function");
  });

  it("returns null on non-Windows platforms", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    for (const platform of ["darwin", "linux", "freebsd"]) {
      expect(detectWindowsVsYear({ platform })).toBeNull();
    }
  });

  it("returns null when vswhere.exe is absent", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    expect(detectWindowsVsYear({
      platform: "win32",
      existsSync: () => false,
    })).toBeNull();
  });

  it("extracts year from vswhere displayName for VS 2026", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    expect(detectWindowsVsYear({
      platform: "win32",
      existsSync: () => true,
      exec: () => "Visual Studio Community 2026",
    })).toBe("2026");
  });

  it("works for all VS editions (Community, Professional, Enterprise)", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    for (const displayName of [
      "Visual Studio Community 2026",
      "Visual Studio Professional 2026",
      "Visual Studio Enterprise 2026",
    ]) {
      expect(detectWindowsVsYear({
        platform: "win32",
        existsSync: () => true,
        exec: () => displayName,
      })).toBe("2026");
    }
  });

  it("works for older VS versions (2017, 2019, 2022)", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    for (const [displayName, year] of [
      ["Visual Studio Community 2017", "2017"],
      ["Visual Studio Community 2019", "2019"],
      ["Visual Studio Community 2022", "2022"],
    ]) {
      expect(detectWindowsVsYear({
        platform: "win32",
        existsSync: () => true,
        exec: () => displayName,
      })).toBe(year);
    }
  });

  it("trims whitespace and CRLF from vswhere output before matching", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    expect(detectWindowsVsYear({
      platform: "win32",
      existsSync: () => true,
      exec: () => "  Visual Studio Community 2026\r\n",
    })).toBe("2026");
  });

  it("returns null when vswhere throws", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    expect(detectWindowsVsYear({
      platform: "win32",
      existsSync: () => true,
      exec: () => { throw new Error("vswhere failed"); },
    })).toBeNull();
  });

  it("returns null when vswhere returns a string with no 4-digit year", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    for (const bad of ["", "18", "unknown"]) {
      expect(detectWindowsVsYear({
        platform: "win32",
        existsSync: () => true,
        exec: () => bad,
      })).toBeNull();
    }
  });

  // ── Slice 2: source-code assertions on buildSafeEnv ───────────────

  it("uses displayName to get the year and extracts it with a regex", () => {
    expect(HEAL_SRC).toMatch(/-property displayName/);
    expect(HEAL_SRC).toMatch(/20\\d\{2\}/);
  });

  it("buildSafeEnv sets npm_config_msvs_version on Windows via vswhere", () => {
    expect(HEAL_SRC).toMatch(/npm_config_msvs_version/);
    expect(HEAL_SRC).toMatch(/vswhere/);
  });

  it("buildSafeEnv only sets npm_config_msvs_version when not already present", () => {
    expect(HEAL_SRC).toMatch(/!\s*env\.npm_config_msvs_version/);
  });
});
