/**
 * Issue #531 — scripts/postinstall.mjs MUST invoke healMcpJsonArgs alongside
 * healPluginJsonMcpServers for users broken by the #253 / aea633c regression
 * or by /ctx-upgrade tmpdir leak. Same escape-hatch posture as v1.0.119:
 * when MCP is dead (because .mcp.json is poisoned with `./start.mjs`), the
 * only way to recover is `npm install -g context-mode` whose postinstall
 * MUST run Layer 6.
 *
 * Static-analysis sibling of start-mjs-self-heal.test.ts's postinstall check
 * — fast, deterministic, no integration spawn.
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const postinstallSrc = readFileSync(resolve(ROOT, "scripts", "postinstall.mjs"), "utf-8");

describe("scripts/postinstall.mjs — Issue #531 Layer 6 .mcp.json heal", () => {
  test("imports healMcpJsonArgs from the shared module", () => {
    expect(postinstallSrc).toContain("healMcpJsonArgs");
    expect(postinstallSrc).toMatch(/heal-installed-plugins\.mjs/);
  });

  test("invokes healMcpJsonArgs alongside healPluginJsonMcpServers", () => {
    // Both heals MUST run in the same per-entry loop. We anchor on the
    // existing #523 heal block (already iterates entries.installPath) and
    // assert the new heal also lives inside it.
    const heal523Idx = postinstallSrc.indexOf("healPluginJsonMcpServers");
    expect(heal523Idx).toBeGreaterThan(-1);
    const heal531Idx = postinstallSrc.indexOf("healMcpJsonArgs");
    expect(heal531Idx).toBeGreaterThan(-1);
    // Distance between them should be modest — both live inside the same
    // per-entry loop, not in some unrelated section.
    expect(Math.abs(heal531Idx - heal523Idx)).toBeLessThan(2000);
  });

  test("Layer 6 heal call passes pluginRoot, pluginCacheRoot, pluginKey", () => {
    // Use lastIndexOf to anchor on the call site, not the import line.
    const idx = postinstallSrc.lastIndexOf("healMcpJsonArgs");
    const block = postinstallSrc.slice(idx, idx + 500);
    expect(block).toContain("pluginRoot");
    expect(block).toContain("pluginCacheRoot");
    expect(block).toContain("pluginKey");
  });

  test("Layer 6 heal is wrapped defensively (per-entry try/catch, never blocks install)", () => {
    // Same posture as Layer 5b: per-call try/catch so one poisoned entry
    // doesn't block heals on the others.
    const idx = postinstallSrc.lastIndexOf("healMcpJsonArgs");
    const block = postinstallSrc.slice(Math.max(0, idx - 200), idx + 500);
    expect(block).toMatch(/try\s*\{/);
  });
});
