import "./setup-home";
/**
 * Tier-2 smoke assertion script — unit coverage.
 *
 * The assert-stats.mjs script is the gating logic for the tier-2 workflow:
 * if it accepts a payload that does not actually prove ctx_* usage, the
 * weekly smoke goes green on a regression. We therefore exercise it as a
 * black-box CLI with synthetic ctx-stats payloads.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(here, "..", "scripts", "tier2-smoke", "assert-stats.mjs");

function runAssert(payload: unknown): { code: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "tier2-assert-"));
  const path = join(dir, "stats.json");
  writeFileSync(path, JSON.stringify(payload), "utf-8");
  const r = spawnSync("node", [SCRIPT, path], { encoding: "utf-8" });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

describe("tier-2 assert-stats.mjs", () => {
  beforeAll(() => {
    // Sanity: script must exist before we try to spawn it.
    const probe = spawnSync("node", [SCRIPT, "--help"], { encoding: "utf-8" });
    // The script does not implement --help, but the spawn itself should
    // succeed (exit non-zero, but not ENOENT).
    expect(probe.error).toBeUndefined();
  });

  it("passes on a healthy payload with all required tools used", () => {
    const r = runAssert({
      tokens_saved: 1234,
      errors: 0,
      tools: {
        ctx_search: { calls: 3 },
        ctx_execute: { calls: 1 },
        ctx_index: { calls: 2 },
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Tier-2 smoke PASSED");
  });

  it("fails when no ctx_* tool was invoked", () => {
    const r = runAssert({
      tokens_saved: 0,
      errors: 0,
      tools: {},
    });
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/at least one ctx_\* tool invocation/);
  });

  it("fails when tokens_saved is zero or missing", () => {
    const r = runAssert({
      // tokens_saved omitted on purpose
      errors: 0,
      tools: {
        ctx_search: { calls: 1 },
        ctx_execute: { calls: 1 },
        ctx_index: { calls: 1 },
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/tokens_saved/);
  });

  it("fails when ctx_search was never called even if other tools ran", () => {
    const r = runAssert({
      tokens_saved: 100,
      errors: 0,
      tools: {
        ctx_execute: { calls: 5 },
        ctx_index: { calls: 5 },
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/ctx_search invoked at least once/);
  });

  it("fails when the host reported tool errors", () => {
    const r = runAssert({
      tokens_saved: 500,
      errors: 2,
      tools: {
        ctx_search: { calls: 1 },
        ctx_execute: { calls: 1 },
        ctx_index: { calls: 1 },
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/no tool reported an error/);
  });

  it("exits with code 2 on malformed JSON instead of silently passing", () => {
    const dir = mkdtempSync(join(tmpdir(), "tier2-assert-bad-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, "{not json", "utf-8");
    const r = spawnSync("node", [SCRIPT, path], { encoding: "utf-8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/could not parse/);
  });
});
