import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ContentStore } from "../../src/store.js";
import {
  resolveDepManifest,
  computeDepDBPath,
  openDepStore,
} from "../../src/deps.js";

const TEST_ROOT = join(tmpdir(), "ctx-deps-test-" + Date.now());
const PROJECT_A = join(TEST_ROOT, "repo-a");
const PROJECT_B = join(TEST_ROOT, "repo-b");

function setupProject(path: string, manifest?: object) {
  mkdirSync(path, { recursive: true });
  if (manifest) {
    writeFileSync(join(path, ".ctx-deps.json"), JSON.stringify(manifest, null, 2));
  }
}

function cleanup() {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
}

describe("resolveDepManifest", () => {
  beforeEach(() => {
    cleanup();
    setupProject(PROJECT_A, { dependencies: { "repo-b": { path: "../repo-b" } } });
    setupProject(PROJECT_B);
  });
  afterEach(cleanup);

  it("parses .ctx-deps.json from project root", () => {
    const manifest = resolveDepManifest(PROJECT_A);
    expect(manifest).not.toBeNull();
    expect(manifest!.dependencies).toHaveProperty("repo-b");
    expect(manifest!.dependencies["repo-b"].path).toBe("../repo-b");
  });

  it("returns null when no .ctx-deps.json exists", () => {
    expect(resolveDepManifest(join(TEST_ROOT, "no-project"))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    writeFileSync(join(PROJECT_A, ".ctx-deps.json"), "{not json}");
    expect(resolveDepManifest(PROJECT_A)).toBeNull();
  });

  it("rejects empty dependency paths", () => {
    setupProject(join(TEST_ROOT, "empty-path"), {
      dependencies: { "bad-dep": { path: "" } },
    });
    const manifest = resolveDepManifest(join(TEST_ROOT, "empty-path"));
    expect(manifest).toBeNull();
  });
});

describe("computeDepDBPath", () => {
  it("is deterministic", () => {
    const cp = join(tmpdir(), ".claude");
    expect(computeDepDBPath("/Users/test/p", cp))
      .toBe(computeDepDBPath("/Users/test/p", cp));
  });

  it("includes context-mode/content in path", () => {
    const cp = join(tmpdir(), ".claude");
    const p = computeDepDBPath("/tmp/foo", cp);
    expect(p).toContain("context-mode");
    expect(p).toContain("content");
    expect(p).toMatch(/\.db$/);
  });
});

describe("openDepStore", () => {
  let configPath: string;
  beforeEach(() => {
    cleanup();
    setupProject(PROJECT_A);
    configPath = join(tmpdir(), ".claude-test");
    mkdirSync(join(configPath, "context-mode", "content"), { recursive: true });
  });
  afterEach(cleanup);

  it("returns null when dep ContentStore DB does not exist", () => {
    expect(openDepStore(PROJECT_B, configPath)).toBeNull();
  });

  it("returns a ContentStore when dep DB exists", () => {
    const depDBPath = computeDepDBPath(PROJECT_B, configPath);
    mkdirSync(join(depDBPath, ".."), { recursive: true });
    const writeStore = new ContentStore(depDBPath);
    writeStore.index({ content: "# Test\n\nSome content", source: "test" });
    writeStore.close();

    const store = openDepStore(PROJECT_B, configPath);
    expect(store).not.toBeNull();
    const results = store!.search("content");
    expect(results.length).toBeGreaterThan(0);
  });
});
