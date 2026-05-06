import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ContentStore } from "../../src/store.js";
import { searchAllSources } from "../../src/search/unified.js";
import { resolveDepManifest, computeDepDBPath, openDepStore } from "../../src/deps.js";

const TEST_ROOT = join(tmpdir(), "ctx-deps-integration-" + Date.now());

function cleanup() {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
}

describe("ctx-deps integration", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("parses manifest, opens dep store, searches across both", () => {
    const currentDir = join(TEST_ROOT, "current");
    const depDir = join(TEST_ROOT, "dep");
    mkdirSync(currentDir, { recursive: true });
    mkdirSync(depDir, { recursive: true });

    writeFileSync(
      join(currentDir, ".ctx-deps.json"),
      JSON.stringify({ dependencies: { "my-dep": { path: "../dep" } } }, null, 2),
    );

    const configPath = join(tmpdir(), ".claude-test-int");
    const depDBPath = computeDepDBPath(depDir, configPath);
    mkdirSync(join(depDBPath, ".."), { recursive: true });
    const depStore = new ContentStore(depDBPath);
    depStore.index({
      content: "# My Dep API\n\n## Functions\n\n- `foo(bar: string): void`\n- `baz(): number`",
      source: "dep-docs",
    });

    const currentStore = new ContentStore();
    currentStore.index({
      content: "# Current Project\n\nCalls foo() from my-dep",
      source: "current",
    });

    const manifest = resolveDepManifest(currentDir);
    expect(manifest).not.toBeNull();

    const depPath = resolve(currentDir, manifest!.dependencies["my-dep"].path);
    const openedDepStore = openDepStore(depPath, configPath);
    expect(openedDepStore).not.toBeNull();

    const results = searchAllSources({
      query: "foo bar baz", limit: 10, store: currentStore,
      depStores: new Map([["my-dep", openedDepStore!]]),
    });

    const depResults = results.filter(r => r.origin === "upstream-dep");
    expect(results.filter(r => r.origin === "current-session").length).toBeGreaterThan(0);
    expect(depResults.length).toBeGreaterThan(0);
    expect(depResults[0].content).toContain("My Dep API");
  });

  it("gracefully handles missing dep ContentStore (null from openDepStore)", () => {
    const currentDir = join(TEST_ROOT, "no-dep-db");
    const depDir = join(TEST_ROOT, "no-dep-db-dep");
    mkdirSync(currentDir, { recursive: true });
    mkdirSync(depDir, { recursive: true });

    writeFileSync(
      join(currentDir, ".ctx-deps.json"),
      JSON.stringify({ dependencies: { "missing-dep": { path: "../no-dep-db-dep" } } }, null, 2),
    );

    const configPath = join(tmpdir(), ".claude-test-missing");
    const manifest = resolveDepManifest(currentDir);
    expect(manifest).not.toBeNull();
    expect(openDepStore(depDir, configPath)).toBeNull();

    const currentStore = new ContentStore();
    currentStore.index({ content: "# Just current", source: "current" });

    const results = searchAllSources({
      query: "current", limit: 10, store: currentStore,
      depStores: new Map(),
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.origin === "current-session")).toBe(true);
  });
});
