/**
 * Package dependency policy tests (#514).
 *
 * On Node 26+, better-sqlite3 declares `engines.node` that excludes the
 * running Node version. npm silently drops `optionalDependencies` whose
 * engines do not match the runtime — no warning, no error, no install.
 * Result: `node_modules/better-sqlite3` is never written, the FTS5
 * knowledge base never opens, and `/ctx-upgrade` cannot recover because
 * `scripts/heal-better-sqlite3.mjs` no-ops on `package-missing`.
 *
 * Fix: better-sqlite3 must live in `dependencies` (not optional). When a
 * required dependency's engines mismatch, npm emits an explicit warning
 * and still installs the package — exactly the loud-failure behavior we
 * need for the install to be diagnosable on Node 26 and beyond.
 *
 * @see https://github.com/mksglu/context-mode/issues/514
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

describe("package.json dependency policy (#514)", () => {
  it("better-sqlite3 lives in dependencies, not optionalDependencies", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    // The whole point of #514: npm silently skips optionalDependencies on
    // engine mismatch (Node 26 vs better-sqlite3@12.x engines field), so
    // the package MUST be a regular dependency to fail loud.
    expect(pkg.dependencies?.["better-sqlite3"]).toBeDefined();
    expect(pkg.optionalDependencies?.["better-sqlite3"]).toBeUndefined();
  });

  it("better-sqlite3 version pin is preserved at ^12.6.2", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    // Demoting the package back to dependencies must NOT bump or drop the
    // pin — the pin is a separate decision tracked in commit history.
    expect(pkg.dependencies?.["better-sqlite3"]).toBe("^12.6.2");
  });
});
