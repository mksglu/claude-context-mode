/**
 * ctx_doctor must distinguish package-missing from binding-missing (#514).
 *
 * Pre-fix behavior:
 *   - "Cannot find module / MODULE_NOT_FOUND" → SKIP (module not available)
 *   - any other throw → bindings-missing flow (issue #408)
 *
 * The pre-fix flow conflates two genuinely distinct failure modes:
 *   - package-missing: node_modules/better-sqlite3 directory absent
 *     (npm silently skipped the package on Node engine mismatch, #514)
 *   - binding-missing: the package directory exists but
 *     build/Release/better_sqlite3.node was never produced
 *     (prebuild-install + node-gyp failed, #408)
 *
 * The recovery commands differ:
 *   - package-missing → `npm install better-sqlite3 --no-optional`
 *     (forces npm to honor the named install even if it would skip an
 *     optional dep due to engine mismatch)
 *   - binding-missing → `npm rebuild better-sqlite3` (the existing #408 flow)
 *
 * doctor() must report them as distinct conditions with distinct hints.
 *
 * @see https://github.com/mksglu/context-mode/issues/514
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CLI_SRC = readFileSync(
  resolve(import.meta.dirname, "../../src/cli.ts"),
  "utf-8",
);

// Pull just the doctor() function body so we don't match unrelated
// occurrences in upgrade() etc.
function getDoctorBody(): string {
  const start = CLI_SRC.indexOf("async function doctor");
  if (start === -1) throw new Error("doctor() function not found");
  const after = CLI_SRC.indexOf("\nasync function ", start + 10);
  const altAfter = CLI_SRC.indexOf("\nfunction ", start + 10);
  const end = [after, altAfter].filter(i => i > -1).sort((a, b) => a - b)[0] ?? CLI_SRC.length;
  return CLI_SRC.slice(start, end);
}

describe("doctor() — distinguishes package-missing vs binding-missing (#514)", () => {
  it("inspects whether node_modules/better-sqlite3 exists, not just the bindings throw shape", () => {
    const body = getDoctorBody();
    // The handler must look at the package directory existence as a
    // signal — without this check it cannot tell whether the dep was
    // installed at all. The path may be constructed via `resolve(...,
    // "node_modules", "better-sqlite3")` (separate string args) or via
    // a path-string literal — both are acceptable.
    const referencesNodeModules = /"node_modules"/.test(body) || /node_modules\//.test(body);
    const referencesBetterSqlite3 = /"better-sqlite3"/.test(body) || /better-sqlite3/.test(body);
    expect(referencesNodeModules).toBe(true);
    expect(referencesBetterSqlite3).toBe(true);
    expect(body).toMatch(/existsSync\([^)]*\)/);
  });

  it("reports a distinct package-missing message that names #514 (or the engine-skip cause)", () => {
    const body = getDoctorBody();
    // Some recognisable signal that this is the package-missing branch,
    // not the binding-missing branch. We accept any one of the
    // following markers as evidence:
    //   - the literal "#514"
    //   - the phrase "package missing" (case insensitive)
    //   - the phrase "engine mismatch" / "engines field"
    //   - the recovery command "npm install better-sqlite3 --no-optional"
    const hasMarker =
      /#514\b/.test(body) ||
      /package[- ]missing/i.test(body) ||
      /engine[- ]?mismatch/i.test(body) ||
      /engines field/i.test(body) ||
      /npm install better-sqlite3 --no-optional/.test(body);
    expect(hasMarker).toBe(true);
  });

  it("keeps the binding-missing (#408) flow intact for prebuild-install/MSVC issues", () => {
    const body = getDoctorBody();
    // Regression guard: the #408 hint must still be present in the
    // binding-missing branch (separate from #514). The "Could not
    // locate the bindings file" detection and the npm rebuild hint
    // both belong to #408 and must not be removed.
    expect(body).toMatch(/Could not locate the bindings file/);
    expect(body).toMatch(/npm rebuild better-sqlite3/);
  });

  it("emits two different remediation commands for the two states", () => {
    const body = getDoctorBody();
    // package-missing recovery: `npm install better-sqlite3 --no-optional`
    // binding-missing recovery: `npm rebuild better-sqlite3` (or the
    // primary `npm install better-sqlite3` from #408).
    const hasInstallNoOptional = /npm install better-sqlite3[^"`]*--no-optional/.test(body);
    const hasRebuild = /npm rebuild better-sqlite3/.test(body);
    expect(hasInstallNoOptional).toBe(true);
    expect(hasRebuild).toBe(true);
  });
});
