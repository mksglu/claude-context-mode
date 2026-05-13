/**
 * db-base platform gate — issue #551 follow-up.
 *
 * Node 26 removed `info.This()` from V8 PropertyCallbackInfo. better-sqlite3
 * 12.9.0 still calls it, so the native addon fails to compile on
 * darwin-arm64 + Node 26. Workaround: prefer the built-in `node:sqlite`
 * adapter (which ships its own SQLite, no native compile) on every platform
 * that has it — not just Linux.
 *
 * v1.0.124 gated `node:sqlite` adoption on `process.platform === "linux"`.
 * v1.0.125 widens the gate to `hasModernSqlite()` (Bun OR Node >= 22.5),
 * matching the helper that already exists in hooks/ensure-deps.mjs:61.
 *
 * Source-level guard: parses src/db-base.ts to assert the gate references
 * `hasModernSqlite` (not the legacy `process.platform === "linux"`).
 * Runtime guard: invokes the exported helper against synthetic Node
 * versions and asserts the expected boolean.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("db-base platform gate (#551)", () => {
  const dbBasePath = resolve(__dirname, "..", "..", "src", "db-base.ts");
  const src = readFileSync(dbBasePath, "utf8");

  it("exports hasModernSqlite helper (Bun OR Node >= 22.5)", async () => {
    const mod = await import("../../src/db-base.js");
    expect(typeof (mod as Record<string, unknown>).hasModernSqlite).toBe("function");
    // The helper must return a boolean for the live runtime (true or false
    // depending on the test environment's Node version).
    const live = (mod as { hasModernSqlite: () => boolean }).hasModernSqlite();
    expect(typeof live).toBe("boolean");
  });

  it("loadDatabase ladder uses hasModernSqlite() — not the legacy linux gate", () => {
    // After the gate widening, the only Linux check that should survive is
    // inside the COMMENT explaining the SIGSEGV history; the runtime branch
    // must call hasModernSqlite().
    const loadDbRegion = src.split("export function loadDatabase")[1] ?? "";
    expect(loadDbRegion).toContain("hasModernSqlite()");
    // Defensive: ensure the legacy gate `process.platform === "linux"` no
    // longer appears as a runtime branch condition in loadDatabase.
    expect(loadDbRegion).not.toMatch(/process\.platform\s*===\s*"linux"/);
  });

  it("hasModernSqlite returns true for Bun and Node >= 22.5", async () => {
    // Sanity: when we mock process.versions.node to 26.0.0 the helper must
    // return true — this is the codepath that fixes the macOS+Node26 break.
    const { hasModernSqlite } = (await import("../../src/db-base.js")) as {
      hasModernSqlite: (versionsOverride?: NodeJS.ProcessVersions, bun?: unknown) => boolean;
    };
    expect(
      hasModernSqlite({ ...process.versions, node: "26.0.0" }, undefined),
    ).toBe(true);
    expect(
      hasModernSqlite({ ...process.versions, node: "22.5.0" }, undefined),
    ).toBe(true);
    // Bun runtime — always true.
    expect(
      hasModernSqlite({ ...process.versions, node: "18.0.0" }, /* fakeBun */ {}),
    ).toBe(true);
    // Old Node, no Bun — false.
    expect(
      hasModernSqlite({ ...process.versions, node: "22.4.0" }, undefined),
    ).toBe(false);
    expect(
      hasModernSqlite({ ...process.versions, node: "20.10.0" }, undefined),
    ).toBe(false);
  });
});
