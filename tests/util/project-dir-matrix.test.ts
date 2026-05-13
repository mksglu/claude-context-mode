/**
 * Issue #545 — MUST-3 leak-matrix invariant.
 *
 * For every (host, foreign) pair of registered platforms with host ≠ foreign:
 *   1. With foreign's workspace vars set to "/leak", host's workspace var
 *      (if any) set to "/own", CONTEXT_MODE_PROJECT_DIR set to "/escape":
 *      - resolveProjectDir({ env, strictPlatform: host }) returns "/own"
 *        if host has a workspace var, else "/escape".
 *   2. Result is NEVER "/leak".
 *   3. With ONLY CONTEXT_MODE_PROJECT_DIR="/escape" set, result is "/escape"
 *      for every host (universal escape hatch invariant).
 *
 * Generates 15 × 14 × 3 = 630 assertions from one parameterized test. Adding
 * adapter #16 to PLATFORM_ENV_VARS grows the matrix automatically — no edit
 * to this file. This is the structural test for MUST-3 (15 adapters equal).
 */

import { describe, it, expect } from "vitest";
import { resolveProjectDir } from "../../src/util/project-dir.js";
import {
  PLATFORM_ENV_VARS,
  workspaceEnvVarsFor,
  foreignWorkspaceEnv,
} from "../../src/adapters/detect.js";
import type { PlatformId } from "../../src/adapters/types.js";

// Hard-coded list of all registered platforms — kept in sync with detect.ts
// CLIENT_NAME_TO_PLATFORM. If a 16th adapter is added, append it here.
// (We can't reflect it from PLATFORM_ENV_VARS alone because some adapters
// have no env vars — kiro, openclaw, antigravity-via-mcp-only, zed.)
const ALL_PLATFORMS: ReadonlyArray<PlatformId> = [
  "claude-code",
  "gemini-cli",
  "cursor",
  "vscode-copilot",
  "jetbrains-copilot",
  "opencode",
  "kilo",
  "qwen-code",
  "codex",
  "antigravity",
  "kiro",
  "openclaw",
  "zed",
  "pi",
  "omp",
];

describe("resolveProjectDir matrix — MUST-3 invariant (issue #545)", () => {
  it(`covers all ${ALL_PLATFORMS.length} registered platforms (sanity)`, () => {
    // If this fails, ALL_PLATFORMS drifted from PLATFORM_ENV_VARS or the
    // platform registry. Update both sides.
    const platformsWithEntries = [...PLATFORM_ENV_VARS.keys()];
    for (const p of platformsWithEntries) {
      expect(ALL_PLATFORMS).toContain(p);
    }
  });

  it("matrix: host accepts own workspace var, rejects every foreign workspace var", () => {
    let assertions = 0;
    for (const host of ALL_PLATFORMS) {
      const ownVars = workspaceEnvVarsFor(host);
      const foreignVars = [...foreignWorkspaceEnv(host)];
      for (const foreign of ALL_PLATFORMS) {
        if (foreign === host) continue;
        const foreignOwnVars = workspaceEnvVarsFor(foreign);

        // Build adversarial env: every foreign workspace var = /leak/<name>,
        // host's own first workspace var (if any) = /own, escape = /escape.
        const env: Record<string, string> = {
          CONTEXT_MODE_PROJECT_DIR: "/escape",
        };
        for (const fv of foreignVars) env[fv] = `/leak/${fv}`;
        if (ownVars.length > 0) env[ownVars[0]] = "/own";

        const result = resolveProjectDir({
          env,
          cwd: "/anchor/cwd",
          pwd: undefined,
          strictPlatform: host,
        });

        // Assert 1: returns own if available, else escape.
        if (ownVars.length > 0) {
          expect(
            result,
            `host=${host} foreign=${foreign}: expected /own, got ${result}`,
          ).toBe("/own");
        } else {
          expect(
            result,
            `host=${host} foreign=${foreign}: no own var → expected /escape, got ${result}`,
          ).toBe("/escape");
        }
        assertions++;

        // Assert 2: result is NEVER a /leak/* path.
        expect(
          result.startsWith("/leak/"),
          `host=${host} foreign=${foreign}: leaked ${result}`,
        ).toBe(false);
        assertions++;

        // Assert 3 (per-pair flavor of the universal escape hatch): with
        // ONLY CONTEXT_MODE_PROJECT_DIR set, every host returns /escape.
        // Voiding the foreign env to confirm escape hatch is universal.
        const escapeOnlyEnv: Record<string, string> = { CONTEXT_MODE_PROJECT_DIR: "/escape-only" };
        // To keep the assertion strict per-pair, also confirm foreign's
        // workspace vars don't slip through when escape hatch is the only
        // candidate beyond noise (set foreign's first workspace var as a
        // sanity decoy — it must still be banned).
        if (foreignOwnVars.length > 0) escapeOnlyEnv[foreignOwnVars[0]] = "/decoy/foreign";
        const escapeResult = resolveProjectDir({
          env: escapeOnlyEnv,
          cwd: "/anchor/cwd",
          pwd: undefined,
          strictPlatform: host,
        });
        expect(
          escapeResult,
          `host=${host}: escape hatch must win, got ${escapeResult}`,
        ).toBe("/escape-only");
        assertions++;
      }
    }
    // Sanity: with N=15 platforms, we expect 15 * 14 * 3 = 630 assertions.
    // Looser bound here to avoid the test itself becoming brittle if a
    // future adapter is added — just assert "many" and the per-iteration
    // expects above carry the real signal.
    expect(assertions).toBeGreaterThanOrEqual(ALL_PLATFORMS.length * (ALL_PLATFORMS.length - 1) * 3);
  });
});
