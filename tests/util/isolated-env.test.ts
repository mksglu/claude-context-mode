/**
 * Behavioral tests for `withIsolatedEnv()` — the Windows-aware test isolation
 * helper that scopes EVERY home/config/temp env var any production code path
 * reads, then restores the originals on `restore()`.
 *
 * Why this exists: `tests/setup-home.ts` only sets HOME/USERPROFILE/HOMEDRIVE/
 * HOMEPATH. On Windows, adapter aggregation (`getMultiAdapterLifetimeStats`,
 * OpenCode's `getConfigDir`, runtime bun fallbacks) reads APPDATA, LOCALAPPDATA,
 * XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME — so real adapter dirs leak
 * into render output. PR #515's BRAND_NEW assertion fails because of this.
 *
 * The contract these tests pin:
 *   - `withIsolatedEnv()` mutates ALL the keys we care about, point them at
 *     a temporary HOME the test uniquely owns.
 *   - `homedir()` and `tmpdir()` return that same dir (covers code that
 *     reads via `node:os` instead of env).
 *   - Internal `CONTEXT_MODE_*` keys + `CLAUDE_PLUGIN_ROOT` are removed so
 *     stale developer state can't leak into the test process.
 *   - `restore()` puts every key back, even ones that were unset originally.
 */

import "../setup-home.js";

import { describe, test, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { existsSync } from "node:fs";

import { fakeHome as suiteFakeHome } from "../setup-home.js";
import { withIsolatedEnv } from "./isolated-env.js";

const KEYS_THAT_MUST_POINT_AT_FAKE_HOME = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CONTEXT_MODE_PROJECT_DIR",
] as const;

const HOMEDRIVE_HOMEPATH = ["HOMEDRIVE", "HOMEPATH"] as const;

describe("withIsolatedEnv() — Slice 1: env round-trip", () => {
  test("sets every home/config/temp key, then restores originals", () => {
    // Pre-seed sentinels BEFORE snapshotting so we can later prove restore()
    // returned those exact values (not a no-op on already-unset keys).
    process.env.CLAUDE_PLUGIN_ROOT = "/should/be/cleared";
    process.env.CONTEXT_MODE_PROJECT_DIR = "/should/be/redirected-then-restored";

    // Snapshot real values — we'll prove restore() puts them back exactly.
    const original: Record<string, string | undefined> = {};
    for (const key of [...KEYS_THAT_MUST_POINT_AT_FAKE_HOME, ...HOMEDRIVE_HOMEPATH, "CLAUDE_PLUGIN_ROOT"]) {
      original[key] = process.env[key];
    }

    const { fakeHome, restore } = withIsolatedEnv();

    try {
      // The fake HOME must exist on disk — callers expect to write into it.
      expect(existsSync(fakeHome)).toBe(true);

      // Every key in the contract must point at the fake home (or a child of it).
      for (const key of KEYS_THAT_MUST_POINT_AT_FAKE_HOME) {
        const value = process.env[key];
        expect(value, `${key} should be set`).toBeTruthy();
        expect(
          value === fakeHome || value!.startsWith(fakeHome),
          `${key}=${value} must be inside fakeHome=${fakeHome}`,
        ).toBe(true);
      }

      // HOMEDRIVE + HOMEPATH must be set. On POSIX HOMEDRIVE is "" because the
      // filesystem root is "/" (Windows would yield "C:" etc.). HOMEPATH carries
      // the rest of the path. We only assert that BOTH keys exist as defined
      // properties of process.env — i.e. setup-home.ts and withIsolatedEnv()
      // touched them so they're consistent on the spawned subprocess too.
      expect(Object.prototype.hasOwnProperty.call(process.env, "HOMEDRIVE")).toBe(true);
      expect(process.env.HOMEPATH).toBeTruthy();

      // Internal env that could leak stale state must be DELETED, not redirected.
      expect(process.env.CLAUDE_PLUGIN_ROOT).toBeUndefined();

      // homedir() must return the scoped fake home (covers code that reads
      // via node:os instead of env).
      expect(homedir()).toBe(fakeHome);

      // tmpdir() must point inside the fake home so per-process DBs (db-base.ts
      // defaultDBPath) don't write into the real OS temp.
      const td = tmpdir();
      expect(td === fakeHome || td.startsWith(fakeHome)).toBe(true);
    } finally {
      restore();
    }

    // After restore: every snapshot must be back exactly. Keys that were unset
    // must again be unset (not coerced to empty string).
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        expect(process.env[key], `${key} should be unset after restore`).toBeUndefined();
      } else {
        expect(process.env[key], `${key} should be restored`).toBe(value);
      }
    }

    // After restore the os mock falls back to the suite-wide fakeHome from
    // setup-home.ts. It must NOT still be returning the scoped fakeHome that
    // restore() just abandoned.
    expect(homedir()).toBe(suiteFakeHome);
    expect(homedir()).not.toBe(fakeHome);

    // Clean up the sentinels — they only existed for this round-trip assertion.
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CONTEXT_MODE_PROJECT_DIR;
  });
});

describe("withIsolatedEnv() — Slice 2: keepXdg opt-in", () => {
  test("keepXdg=true preserves XDG_* keys verbatim instead of redirecting", () => {
    process.env.XDG_CONFIG_HOME = "/explicit/xdg/config";
    process.env.XDG_DATA_HOME = "/explicit/xdg/data";
    process.env.XDG_CACHE_HOME = "/explicit/xdg/cache";

    const { restore } = withIsolatedEnv({ keepXdg: true });

    try {
      expect(process.env.XDG_CONFIG_HOME).toBe("/explicit/xdg/config");
      expect(process.env.XDG_DATA_HOME).toBe("/explicit/xdg/data");
      expect(process.env.XDG_CACHE_HOME).toBe("/explicit/xdg/cache");

      // Non-XDG keys still redirect — keepXdg is scoped to XDG_*.
      expect(process.env.HOME).not.toBe(undefined);
      expect(process.env.HOME).not.toBe("/explicit/xdg/config");
    } finally {
      restore();
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.XDG_DATA_HOME;
      delete process.env.XDG_CACHE_HOME;
    }
  });
});

describe("withIsolatedEnv() — Slice 3: analytics surface zero adapter rows", () => {
  test("getMultiAdapterLifetimeStats returns zero events under isolated env", async () => {
    const { fakeHome, restore } = withIsolatedEnv();

    try {
      // Late import so the helper's homedir spy is in place before the
      // analytics module captures it. Analytics defaults `home` to homedir().
      const { getMultiAdapterLifetimeStats } = await import(
        "../../src/session/analytics.js"
      );

      const stats = getMultiAdapterLifetimeStats();

      expect(stats.totalEvents, "no adapter dirs exist under fakeHome").toBe(0);
      expect(stats.totalSessions).toBe(0);
      expect(stats.totalBytes).toBe(0);

      // Sanity: fakeHome is empty — no adapter has ever written to it.
      expect(existsSync(fakeHome)).toBe(true);
    } finally {
      restore();
    }
  });
});
