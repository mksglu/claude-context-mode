/**
 * atomic-fs (ESM, scripts/) — atomic writes for shared JSON config files.
 *
 * Parallel to `src/util/atomic-fs.ts` but inlined as pure ESM because
 * scripts in this directory are NOT bundled and cannot import from
 * `src/`. The two helpers intentionally have the same shape so they can
 * be consolidated later; for now they live in different runtime zones.
 *
 * @see ../../src/util/atomic-fs.ts
 */

import {
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";

/** Tracked target dirs we should sweep at process exit. */
const trackedDirs = new Set();
let exitHandlerInstalled = false;

function installExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on("exit", () => {
    for (const dir of trackedDirs) {
      try {
        for (const name of readdirSync(dir)) {
          if (!name.startsWith(".tmp.")) continue;
          try { unlinkSync(join(dir, name)); } catch { /* raced */ }
        }
      } catch { /* dir gone */ }
    }
  });
}

function writeWithMode(path, content, opts) {
  if (typeof content === "string") {
    writeFileSync(path, content, { encoding: opts.encoding ?? "utf-8" });
  } else {
    writeFileSync(path, content);
  }
  if (opts.mode !== undefined) {
    try { chmodSync(path, opts.mode); } catch { /* best effort */ }
  }
}

function tryUnlink(path) {
  try { unlinkSync(path); } catch { /* ignore */ }
}

/**
 * Atomically write `content` to `path` (tmp + rename, same-filesystem).
 *
 * @param {string} path - target file path
 * @param {string | Buffer} content - file contents
 * @param {{ mode?: number, encoding?: BufferEncoding }} [opts]
 */
export function atomicWriteFileSync(path, content, opts = {}) {
  const dir = dirname(path);
  const suffix = `${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}`;
  const tmpPath = join(dir, `.tmp.${basename(path)}.${suffix}`);

  installExitHandler();
  trackedDirs.add(dir);

  writeWithMode(tmpPath, content, opts);

  try {
    renameSync(tmpPath, path);
  } catch (err) {
    if (!err || err.code !== "EXDEV") {
      tryUnlink(tmpPath);
      throw err;
    }
    try {
      writeWithMode(path, content, opts);
    } finally {
      tryUnlink(tmpPath);
    }
    console.error(
      `atomic-fs: rename across mounts; wrote ${path} non-atomically (EXDEV)`,
    );
  }
}
