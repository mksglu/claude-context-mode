// atomic-fs.mjs — atomic write helper for hook scripts (ESM, no bundling).
//
// Why this exists:
//   Shared JSON config files (~/.claude/settings.json, installed_plugins.json,
//   plugin.json, hooks.json) are mutated by multiple processes:
//     - the MCP server itself via start.mjs and src/* code
//     - per-tool hook subprocesses spawned by Claude Code (pretooluse.mjs etc.)
//     - the cache-heal hook deployed under ~/.claude/hooks/
//   When two of these race, a naive readFileSync → mutate → writeFileSync
//   can leave a truncated/torn file on disk because writeFileSync(path, ...)
//   first opens with O_TRUNC and then writes in chunks. A second process that
//   reads in the window between truncate and write sees an empty file.
//
// Contract:
//   atomicWriteFileSync(finalPath, content, opts?) writes `content` to a
//   sibling temp file in the same directory, fsyncs it (best-effort), then
//   renames over `finalPath`. rename() is atomic on the same filesystem
//   (POSIX + Windows), so concurrent readers always see either the old
//   complete file or the new complete file — never a partial write.
//
//   On EXDEV (cross-mount, e.g. tmp dir on a different FS) we fall back to
//   a plain writeFileSync with a console.error warning. This shouldn't
//   happen for the call sites this module covers (all target the same
//   ~/.claude tree where the tmp file lives) but the fallback keeps the
//   helper safe for any future caller that hands it a path on a different
//   mount.
//
// Mirrors src/server.ts:813-816 (persistStats) — but uses a random suffix
// instead of a static `.tmp` extension, so concurrent writers do not
// collide on the temp file itself.

import {
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
  readdirSync,
  constants as fsConstants,
} from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";

const TMP_PREFIX = ".tmp.";

/**
 * Create a temp file in `dir` with a unique random suffix using O_EXCL.
 * Returns the absolute path. Throws on EEXIST after a small bounded retry
 * (random collisions are practically impossible — 8 hex bytes — but we
 * defend anyway).
 */
function createUniqueTmp(dir, base, mode) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  const fileMode = typeof mode === "number" ? mode : 0o600;
  for (let i = 0; i < 5; i++) {
    const suffix = randomBytes(8).toString("hex");
    const candidate = join(dir, `${TMP_PREFIX}${base}.${suffix}`);
    try {
      const fd = openSync(candidate, flags, fileMode);
      closeSync(fd);
      return candidate;
    } catch (err) {
      if (err && err.code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error(`atomic-fs: could not create unique tmp file in ${dir}`);
}

/**
 * Atomically write `content` to `finalPath`.
 *
 * - opts.mode: numeric file mode (e.g. 0o755). When provided, applied to
 *   the final file via writeFileSync's `mode` option (Node respects mode
 *   on create + write).
 * - opts.encoding: defaults to "utf-8".
 *
 * Strategy:
 *   1. Create sibling tmp file in same directory via O_EXCL (random suffix).
 *   2. writeFileSync(tmp, content, {mode, encoding}).
 *   3. renameSync(tmp, finalPath) — atomic on same FS.
 *   4. On EXDEV → plain writeFileSync(finalPath, ...) with warning.
 *
 * Throws on non-EXDEV write errors so callers (typically wrapped in
 * try/catch best-effort blocks) see real failures.
 */
export function atomicWriteFileSync(finalPath, content, opts = {}) {
  const dir = dirname(finalPath);
  const base = basename(finalPath);
  const mode = typeof opts.mode === "number" ? opts.mode : undefined;
  const encoding = opts.encoding ?? "utf-8";
  const writeOpts = mode !== undefined ? { mode, encoding } : { encoding };

  let tmpPath;
  try {
    tmpPath = createUniqueTmp(dir, base, mode);
  } catch (err) {
    // Never let atomic-write infra block a config heal — fall through to
    // plain write if we can't even create a tmp file.
    console.error(
      `atomic-fs: could not create tmp file in ${dir}: ${err && err.message}; falling back to plain write`,
    );
    writeFileSync(finalPath, content, writeOpts);
    return;
  }

  try {
    writeFileSync(tmpPath, content, writeOpts);
    // Best-effort fsync of the tmp file. Skip on platforms where it would
    // fail (older Node + Windows have flaky fsync on regular files).
    try {
      const fd = openSync(tmpPath, fsConstants.O_RDONLY);
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch {
      /* best-effort */
    }
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    if (err && err.code === "EXDEV") {
      console.error(
        `atomic-fs: rename across mount points (${tmpPath} → ${finalPath}); falling back to plain write`,
      );
      writeFileSync(finalPath, content, writeOpts);
      return;
    }
    throw err;
  }
}

/**
 * Best-effort cleanup of stale `.tmp.<base>.*` files in `dir`.
 * Called on process exit to avoid leaving orphans behind when a writer
 * crashes after creating the tmp file but before rename().
 *
 * Only removes files that look like atomic-fs tmps — never touches anything
 * else. Synchronous because `process.on("exit")` is sync-only.
 */
function cleanupStaleTmpsSync(dir, base) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const wantPrefix = `${TMP_PREFIX}${base}.`;
  for (const name of entries) {
    if (!name.startsWith(wantPrefix)) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* best-effort */
    }
  }
}

const trackedTargets = new Set();
let exitHandlerInstalled = false;

function ensureExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on("exit", () => {
    for (const target of trackedTargets) {
      const dir = dirname(target);
      const base = basename(target);
      cleanupStaleTmpsSync(dir, base);
    }
  });
}

/**
 * Register a path so that any leftover `.tmp.<base>.*` siblings get cleaned
 * up on process exit. Optional — most callers don't need this since the
 * happy path renames the tmp atomically and the failure path unlinks it.
 *
 * Exported for tests + future callers that want defense-in-depth.
 */
export function trackForCleanup(finalPath) {
  trackedTargets.add(finalPath);
  ensureExitHandler();
}
