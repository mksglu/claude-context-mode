/**
 * Windows-aware test isolation helper.
 *
 * `tests/setup-home.ts` only sets HOME/USERPROFILE/HOMEDRIVE/HOMEPATH. That's
 * enough on POSIX where session state is `~/.{adapter}/...`, but on Windows
 * `getMultiAdapterLifetimeStats`, OpenCode's `getConfigDir`, and the bun
 * runtime fallbacks read `%APPDATA%`, `%LOCALAPPDATA%`, `XDG_CONFIG_HOME`,
 * `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `TMPDIR`, `TEMP`, `TMP` directly. Without
 * isolating those, real adapter dirs leak into render output and PR #515's
 * BRAND_NEW assertion fails on the windows-latest runner.
 *
 * Usage in-process (mutation + restore):
 *
 *     import "../setup-home.js";              // installs node:os mock
 *     import { withIsolatedEnv } from "../util/isolated-env.js";
 *     const { fakeHome, restore } = withIsolatedEnv();
 *     try { ... } finally { restore(); }
 *
 * Usage as subprocess `env` payload (no global mutation, no os mock needed):
 *
 *     import { buildIsolatedEnvObject } from "../util/isolated-env.js";
 *     const { fakeHome, env } = buildIsolatedEnvObject();
 *     spawnSync("node", [STATUSLINE], { env: { ...process.env, ...env } });
 *
 * Both paths produce identical key sets so a test can swap between in-process
 * and subprocess patterns without the env contract drifting.
 *
 * The `node:os` mock is installed by importing `tests/setup-home.ts` (which
 * uses `vi.mock("node:os")` — the only ESM-safe way to redirect `homedir()` /
 * `tmpdir()` from JS code that imports them as named exports). The mock reads
 * from `currentFakeHome` below, which `withIsolatedEnv()` rewrites in-place.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir as realTmpdir } from "node:os";
import { join, parse } from "node:path";

import { setActiveFakeHome, getActiveFakeHome } from "./isolated-env-state.js";

/** Keys that get redirected to point at the fake HOME (or a child thereof). */
const REDIRECT_KEYS = [
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

/** Keys that get split out from the fake HOME (Windows drive convention). */
const HOMEDRIVE_HOMEPATH_KEYS = ["HOMEDRIVE", "HOMEPATH"] as const;

/**
 * Keys that must be DELETED outright — these point at developer-machine state
 * (plugin install root, internal session-dir overrides) that would otherwise
 * leak across the test boundary even with HOME redirected.
 */
const DELETE_KEYS = [
  "CLAUDE_PLUGIN_ROOT",
  "CONTEXT_MODE_SESSION_DIR",
  "CONTEXT_MODE_SESSION_SUFFIX",
  "CONTEXT_MODE_SESSION_DB",
] as const;

const ALL_TRACKED = [
  ...REDIRECT_KEYS,
  ...HOMEDRIVE_HOMEPATH_KEYS,
  ...DELETE_KEYS,
] as const;

export interface IsolatedEnvOpts {
  /**
   * When true, leave existing `XDG_CONFIG_HOME` / `XDG_DATA_HOME` /
   * `XDG_CACHE_HOME` values untouched. Useful for suites that explicitly
   * exercise XDG-resolved paths and don't want them flattened to the fake home.
   */
  keepXdg?: boolean;
}

export interface IsolatedEnvHandle {
  /** Absolute path to the temporary HOME the test owns. Always exists on disk. */
  fakeHome: string;
  /**
   * Reverts every key (and the os mock) to the value it had at
   * `withIsolatedEnv()` call time. Idempotent.
   */
  restore: () => void;
}

/**
 * Build the env-mutation payload without touching `process.env`. Subprocess
 * tests spread this into spawn `env`. Pure — safe to call repeatedly. Returns
 * the payload PLUS the fake HOME path so callers can seed fixtures inside it
 * before spawning.
 */
export function buildIsolatedEnvObject(opts?: IsolatedEnvOpts): {
  fakeHome: string;
  env: Record<string, string>;
} {
  const fakeHome = mkdtempSync(join(realTmpdir(), "ctx-isolated-home-"));
  return { fakeHome, env: envForHome(fakeHome, opts) };
}

function envForHome(fakeHome: string, opts?: IsolatedEnvOpts): Record<string, string> {
  const root = parse(fakeHome).root;
  const env: Record<string, string> = {
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    HOMEDRIVE: root.replace(/[\\/]+$/, ""),
    HOMEPATH: fakeHome.slice(root.length) || root,
    APPDATA: join(fakeHome, "AppData", "Roaming"),
    LOCALAPPDATA: join(fakeHome, "AppData", "Local"),
    TMPDIR: fakeHome,
    TEMP: fakeHome,
    TMP: fakeHome,
    CONTEXT_MODE_PROJECT_DIR: fakeHome,
  };
  if (!opts?.keepXdg) {
    env.XDG_CONFIG_HOME = join(fakeHome, ".config");
    env.XDG_DATA_HOME = join(fakeHome, ".local", "share");
    env.XDG_CACHE_HOME = join(fakeHome, ".cache");
  }
  return env;
}

/**
 * Mutate `process.env` to point at a fresh isolated HOME, point the os mock
 * (installed by `tests/setup-home.ts`) at that HOME, and return a `restore()`
 * that puts everything back. Round-trip safe — keys that were unset before
 * become unset again (not coerced to empty string).
 */
export function withIsolatedEnv(opts?: IsolatedEnvOpts): IsolatedEnvHandle {
  const fakeHome = mkdtempSync(join(realTmpdir(), "ctx-isolated-home-"));
  const env = envForHome(fakeHome, opts);

  // Snapshot every key we're about to touch — `undefined` means "was unset".
  const snapshot = new Map<string, string | undefined>();
  for (const key of ALL_TRACKED) {
    snapshot.set(key, process.env[key]);
  }

  // When keepXdg is true we still snapshot XDG_* so a later restore doesn't
  // accidentally clobber them.
  if (opts?.keepXdg) {
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const) {
      snapshot.set(key, process.env[key]);
    }
  }

  // Apply: set redirect keys, delete delete-keys.
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  for (const key of DELETE_KEYS) {
    delete process.env[key];
  }

  // Point the os mock at the new fake home for the duration of the scope.
  const previousActiveFakeHome = getActiveFakeHome();
  setActiveFakeHome(fakeHome);

  const restore = () => {
    for (const [key, value] of snapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    setActiveFakeHome(previousActiveFakeHome);
  };

  return { fakeHome, restore };
}
