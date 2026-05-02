import "../setup-home";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Slice 7 — OpenCode/KiloCode silently changed where they store npm
 * plugins (now `packages/context-mode@latest/node_modules/context-mode`).
 * The old `node_modules/context-mode` path no longer exists, so doctor
 * + upgrade reported false negatives.
 *
 * Static guard against regression of the published path layout.
 * (Per PR #376.)
 */

const CLI_SRC = readFileSync(resolve(__dirname, "../../src/cli.ts"), "utf-8");

describe("cachePluginRoot — OpenCode/KiloCode 2025+ layout", () => {
  it("uses the new packages/context-mode@latest layout on POSIX", () => {
    // The string `context-mode@latest` should appear in cli.ts (was missing
    // before PR #376). Spread args mean we don't expect a single literal path.
    expect(CLI_SRC).toMatch(/"context-mode@latest"/);
    expect(CLI_SRC).toMatch(/\.cache/);
  });

  it("uses the matching packages/context-mode@latest layout on Windows", () => {
    // Path segments are passed via spread so the literal substring won't appear
    // sequentially; instead assert the spread + Windows branch are both present.
    expect(CLI_SRC).toMatch(/process\.platform\s*===\s*"win32"/);
    expect(CLI_SRC).toMatch(/"packages"\s*,\s*"context-mode@latest"/);
    expect(CLI_SRC).toMatch(/AppData[\s\S]{0,200}Local/);
  });
});
