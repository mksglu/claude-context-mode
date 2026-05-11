/**
 * version-sync tests — guards the cross-manifest version invariant.
 *
 * The npm `version` lifecycle calls `scripts/version-sync.mjs` to copy
 * `package.json:version` into every shipped manifest. When a new plugin
 * surface is added (Cursor, Codex, OMP, Pi, …), it MUST be added to BOTH:
 *
 *   1. `scripts/version-sync.mjs` → `targets[]` (so the value gets written)
 *   2. `package.json` → `scripts.version` `git add` list (so it is staged
 *      by the npm `version` hook into the release commit)
 *
 * If either is missing, the manifest will drift on every release. This
 * has happened in real life — `.cursor-plugin/plugin.json` got stuck at
 * v1.0.111 because it was in the targets list but the cursor adapter
 * landed before its manifest version was bumped. End-to-end test below
 * runs version-sync against a temp scratch repo and asserts every
 * manifest is rewritten.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT_SRC = readFileSync(resolve(REPO_ROOT, "scripts/version-sync.mjs"), "utf8");
const PKG_JSON = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: { version: string };
};

describe("scripts/version-sync.mjs targets", () => {
  it("includes .codex-plugin/plugin.json", () => {
    expect(SCRIPT_SRC).toContain('".codex-plugin/plugin.json"');
  });

  it("includes .codex-plugin/marketplace.json", () => {
    expect(SCRIPT_SRC).toContain('".codex-plugin/marketplace.json"');
  });
});

describe("package.json `version` script `git add` list", () => {
  it("includes .codex-plugin/plugin.json", () => {
    expect(PKG_JSON.scripts.version).toContain(".codex-plugin/plugin.json");
  });

  it("includes .codex-plugin/marketplace.json", () => {
    expect(PKG_JSON.scripts.version).toContain(".codex-plugin/marketplace.json");
  });
});

describe("shipped manifests are in lockstep with package.json", () => {
  // Catches drift like `.cursor-plugin/plugin.json` stuck at v1.0.111
  // while package.json was at v1.0.118 — happened because the cursor
  // manifest was missing from the npm `version` lifecycle `git add` list
  // so even though version-sync rewrote it, the change was never staged.
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  const SHIPPED = [
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".codex-plugin/marketplace.json",
    ".openclaw-plugin/openclaw.plugin.json",
    ".openclaw-plugin/package.json",
    "openclaw.plugin.json",
    ".pi/extensions/context-mode/package.json",
  ];
  for (const manifest of SHIPPED) {
    it(`${manifest} matches package.json version`, () => {
      const content = JSON.parse(readFileSync(resolve(REPO_ROOT, manifest), "utf8")) as {
        version?: string;
        metadata?: { version?: string };
        plugins?: Array<{ version?: string }>;
      };
      const reported = content.version ?? content.metadata?.version ?? content.plugins?.[0]?.version;
      expect(reported, `${manifest} has no recognizable version field`).toBeDefined();
      expect(reported).toBe(pkg.version);
    });
  }
});

describe("version-sync end-to-end", () => {
  it("rewrites every manifest (including .cursor-plugin and .codex-plugin) to the package.json version", () => {
    // Copy a minimal subset of the repo into a scratch dir, then run
    // version-sync there and assert every target ends up at the same version.
    const scratch = mkdtempSync(join(tmpdir(), "version-sync-test-"));
    try {
      // Mirror the directory structure version-sync expects.
      const dirs = [
        ".claude-plugin",
        ".cursor-plugin",
        ".codex-plugin",
        ".openclaw-plugin",
        ".pi/extensions/context-mode",
        "scripts",
      ];
      for (const d of dirs) mkdirSync(join(scratch, d), { recursive: true });

      // Copy the actual manifests (drives a real, not synthetic, assertion).
      const manifests = [
        ".claude-plugin/plugin.json",
        ".claude-plugin/marketplace.json",
        ".cursor-plugin/plugin.json",
        ".codex-plugin/plugin.json",
        ".codex-plugin/marketplace.json",
        ".openclaw-plugin/openclaw.plugin.json",
        ".openclaw-plugin/package.json",
        "openclaw.plugin.json",
        ".pi/extensions/context-mode/package.json",
      ];
      for (const m of manifests) {
        cpSync(resolve(REPO_ROOT, m), join(scratch, m));
      }
      cpSync(resolve(REPO_ROOT, "scripts/version-sync.mjs"), join(scratch, "scripts/version-sync.mjs"));

      // Write a synthetic package.json with a fresh version we can detect.
      const TEST_VERSION = "9.9.9-test";
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ name: "context-mode", version: TEST_VERSION }, null, 2),
      );

      const result = spawnSync("node", ["scripts/version-sync.mjs"], {
        cwd: scratch,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);

      for (const m of manifests) {
        const content = JSON.parse(readFileSync(join(scratch, m), "utf8"));
        const checks: Array<{ path: string; value: unknown }> = [];
        if (content.version !== undefined) checks.push({ path: "version", value: content.version });
        if (content.metadata?.version !== undefined) {
          checks.push({ path: "metadata.version", value: content.metadata.version });
        }
        if (Array.isArray(content.plugins)) {
          for (let i = 0; i < content.plugins.length; i++) {
            const p = content.plugins[i] as { version?: string };
            if (p.version !== undefined) {
              checks.push({ path: `plugins[${i}].version`, value: p.version });
            }
          }
        }
        for (const c of checks) {
          expect(c.value, `${m}.${c.path} should be ${TEST_VERSION}`).toBe(TEST_VERSION);
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
