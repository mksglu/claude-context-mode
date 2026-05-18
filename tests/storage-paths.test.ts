import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatStorageDirectoryError,
  resolveContentStorageDir,
  resolveSessionStorageDir,
  resolveStatsStorageDir,
  StorageDirectoryError,
} from "../src/storage-paths.js";

const ENV_KEYS = [
  "CONTEXT_MODE_DIR",
  "CONTEXT_MODE_SESSION_DIR",
  "CONTEXT_MODE_CONTENT_DIR",
  "CONTEXT_MODE_STATS_DIR",
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

function resetEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("storage path overrides", () => {
  afterEach(() => {
    resetEnv();
  });

  it("uses adapter defaults when no storage override is set", () => {
    for (const key of ENV_KEYS) delete process.env[key];

    const session = resolveSessionStorageDir(() => "/home/me/.codex/context-mode/sessions");
    const content = resolveContentStorageDir(() => session.path);
    const stats = resolveStatsStorageDir(() => session.path);

    expect(session).toMatchObject({
      path: resolve("/home/me/.codex/context-mode/sessions"),
      envVar: null,
      source: "default",
    });
    expect(content).toMatchObject({
      path: resolve("/home/me/.codex/context-mode/content"),
      envVar: null,
      source: "default",
    });
    expect(stats).toMatchObject({
      path: resolve("/home/me/.codex/context-mode/sessions"),
      envVar: null,
      source: "default",
    });
  });

  it("uses CONTEXT_MODE_DIR as base for sessions, content, and stats", () => {
    process.env.CONTEXT_MODE_DIR = "tmp/context-mode";
    delete process.env.CONTEXT_MODE_SESSION_DIR;
    delete process.env.CONTEXT_MODE_CONTENT_DIR;
    delete process.env.CONTEXT_MODE_STATS_DIR;

    const session = resolveSessionStorageDir(() => "/ignored/sessions");
    const content = resolveContentStorageDir(() => session.path);
    const stats = resolveStatsStorageDir(() => session.path);

    expect(session.path).toBe(resolve("tmp/context-mode", "sessions"));
    expect(content.path).toBe(resolve("tmp/context-mode", "content"));
    expect(stats.path).toBe(resolve("tmp/context-mode", "sessions"));
  });

  it("lets split overrides beat CONTEXT_MODE_DIR", () => {
    process.env.CONTEXT_MODE_DIR = "/base/context-mode";
    process.env.CONTEXT_MODE_SESSION_DIR = "/split/sessions";
    process.env.CONTEXT_MODE_CONTENT_DIR = "/split/content";
    process.env.CONTEXT_MODE_STATS_DIR = "/split/stats";

    const session = resolveSessionStorageDir(() => "/ignored/sessions");
    const content = resolveContentStorageDir(() => session.path);
    const stats = resolveStatsStorageDir(() => session.path);

    expect(session.path).toBe(resolve("/split/sessions"));
    expect(session.envVar).toBe("CONTEXT_MODE_SESSION_DIR");
    expect(content.path).toBe(resolve("/split/content"));
    expect(content.envVar).toBe("CONTEXT_MODE_CONTENT_DIR");
    expect(stats.path).toBe(resolve("/split/stats"));
    expect(stats.envVar).toBe("CONTEXT_MODE_STATS_DIR");
  });

  it("formats storage permission errors with path and relevant override vars", () => {
    const err = new StorageDirectoryError(
      "content",
      "/Users/me/.codex/context-mode/content",
      "CONTEXT_MODE_CONTENT_DIR",
      Object.assign(new Error("EPERM"), { code: "EPERM" }),
    );

    expect(formatStorageDirectoryError(err)).toContain(
      "context-mode content directory is not writable: /Users/me/.codex/context-mode/content",
    );
    expect(formatStorageDirectoryError(err)).toContain(
      "Set CONTEXT_MODE_DIR or CONTEXT_MODE_CONTENT_DIR to a writable path.",
    );
  });
});
