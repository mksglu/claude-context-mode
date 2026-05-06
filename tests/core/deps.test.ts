import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ContentStore } from "../../src/store.js";
import {
  resolveDepManifest,
  computeDepDBPath,
  openDepStore,
  addDepToManifest,
  removeDepFromManifest,
  writeResolvedConfig,
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

describe("addDepToManifest", () => {
  beforeEach(() => { cleanup(); mkdirSync(PROJECT_A, { recursive: true }); });
  afterEach(cleanup);

  it("creates .ctx-deps.json and adds a dependency", () => {
    expect(existsSync(join(PROJECT_A, ".ctx-deps.json"))).toBe(false);
    const result = addDepToManifest(PROJECT_A, "my-dep", "../my-dep");
    expect(result.added).toBe(true);
    expect(existsSync(join(PROJECT_A, ".ctx-deps.json"))).toBe(true);
    const manifest = resolveDepManifest(PROJECT_A);
    expect(manifest?.dependencies["my-dep"].path).toBe("../my-dep");
  });

  it("adds to existing .ctx-deps.json", () => {
    writeFileSync(join(PROJECT_A, ".ctx-deps.json"), JSON.stringify({
      dependencies: { "existing": { path: "../existing" } },
    }));
    const result = addDepToManifest(PROJECT_A, "new-dep", "../new-dep");
    expect(result.added).toBe(true);
    const manifest = resolveDepManifest(PROJECT_A);
    expect(manifest?.dependencies).toHaveProperty("existing");
    expect(manifest?.dependencies).toHaveProperty("new-dep");
  });

  it("returns error for duplicate name", () => {
    writeFileSync(join(PROJECT_A, ".ctx-deps.json"), JSON.stringify({
      dependencies: { "dup": { path: "../first" } },
    }));
    const result = addDepToManifest(PROJECT_A, "dup", "../second");
    expect(result.added).toBe(false);
    expect(result.error).toContain("already exists");
  });

  it("returns error for malformed existing .ctx-deps.json", () => {
    writeFileSync(join(PROJECT_A, ".ctx-deps.json"), "{not json}");
    const result = addDepToManifest(PROJECT_A, "dep", "../dep");
    expect(result.added).toBe(false);
    expect(result.error).toContain("Invalid JSON");
  });
});

describe("removeDepFromManifest", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(PROJECT_A, { recursive: true });
    writeFileSync(join(PROJECT_A, ".ctx-deps.json"), JSON.stringify({
      dependencies: { "keep": { path: "../keep" }, "drop": { path: "../drop" } },
    }));
  });
  afterEach(cleanup);

  it("removes a dependency", () => {
    const result = removeDepFromManifest(PROJECT_A, "drop");
    expect(result.removed).toBe(true);
    const manifest = resolveDepManifest(PROJECT_A);
    expect(manifest?.dependencies).toHaveProperty("keep");
    expect(manifest?.dependencies).not.toHaveProperty("drop");
  });

  it("deletes .ctx-deps.json when last dep removed", () => {
    removeDepFromManifest(PROJECT_A, "drop");
    const result = removeDepFromManifest(PROJECT_A, "keep");
    expect(result.removed).toBe(true);
    expect(result.deletedFile).toBe(true);
    expect(existsSync(join(PROJECT_A, ".ctx-deps.json"))).toBe(false);
  });

  it("returns error when .ctx-deps.json does not exist", () => {
    const result = removeDepFromManifest(join(TEST_ROOT, "no-file"), "dep");
    expect(result.removed).toBe(false);
    expect(result.error).toContain("No .ctx-deps.json");
  });

  it("returns error for unknown name", () => {
    const result = removeDepFromManifest(PROJECT_A, "nonexistent");
    expect(result.removed).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("writeResolvedConfig", () => {
  const configDir = join(tmpdir(), ".claude-wrc-test");
  const projDir = join(TEST_ROOT, "wrc-project");

  beforeEach(() => {
    cleanup();
    mkdirSync(projDir, { recursive: true });
    mkdirSync(join(configDir, "context-mode", "content"), { recursive: true });
  });
  afterEach(cleanup);

  it("writes resolved config with absolute paths", () => {
    writeResolvedConfig(projDir, configDir, [
      { name: "a", path: "/abs/path/a" },
      { name: "b", path: "/abs/path/b" },
    ]);
    const hash = require("crypto").createHash("sha256")
      .update(projDir.replace(/\\/g, "/")).digest("hex").slice(0, 16);
    const p = join(configDir, "context-mode", "content", `${hash}-deps.json`);
    expect(existsSync(p)).toBe(true);
    const data = JSON.parse(readFileSync(p, "utf-8"));
    expect(data.deps.length).toBe(2);
    expect(data.deps[0].name).toBe("a");
    expect(data.deps[0].path).toBe("/abs/path/a");
  });

  it("deletes resolved config when deps is empty", () => {
    const hash = require("crypto").createHash("sha256")
      .update(projDir.replace(/\\/g, "/")).digest("hex").slice(0, 16);
    const p = join(configDir, "context-mode", "content", `${hash}-deps.json`);
    writeFileSync(p, "{}");
    writeResolvedConfig(projDir, configDir, []);
    expect(existsSync(p)).toBe(false);
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
