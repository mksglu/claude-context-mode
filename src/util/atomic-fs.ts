/**
 * atomic-fs — atomic writes for shared JSON config files.
 *
 * Use this for any file that another process (a different MCP child, a
 * concurrent hook, a parallel `npm install -g`) may read or write. The
 * helper avoids torn writes / partial JSON by:
 *
 *   1. Writing the new contents to a uniquely-named tmp file in the SAME
 *      directory as the target (so `renameSync` is a same-filesystem op).
 *   2. Atomically `renameSync`-ing the tmp file over the final path.
 *      POSIX `rename()` is atomic for same-filesystem replacements;
 *      readers see either the old contents or the new contents, never a
 *      half-written file.
 *
 * On EXDEV (cross-mount — e.g. someone pointed `~/.claude/` at a different
 * volume than `/tmp`), we fall back to a plain `writeFileSync` and emit a
 * one-line stderr warning. The race window remains but the program does
 * not abort.
 *
 * Best-effort cleanup: a `process.on("exit")` handler removes any stale
 * `.tmp.<basename>.*` tmp files in the target directory left behind by a
 * crash mid-write.
 *
 * Pattern reference: `src/server.ts` persistStats() (the canonical
 * tmp+rename block in the project).
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

export interface AtomicWriteOptions {
  /** chmod the final file to this mode after rename. */
  mode?: number;
  /** Encoding passed to `writeFileSync`. Ignored when `content` is a Buffer. */
  encoding?: BufferEncoding;
}

/** Tracked target dirs we should sweep at process exit. */
const trackedDirs = new Set<string>();
let exitHandlerInstalled = false;

function installExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on("exit", () => {
    for (const dir of trackedDirs) {
      try {
        for (const name of readdirSync(dir)) {
          if (!name.startsWith(".tmp.")) continue;
          try {
            unlinkSync(join(dir, name));
          } catch {
            // ignore; another process may have raced us
          }
        }
      } catch {
        // dir may no longer exist
      }
    }
  });
}

function writeWithMode(
  path: string,
  content: string | Buffer,
  opts: AtomicWriteOptions,
): void {
  if (typeof content === "string") {
    writeFileSync(path, content, { encoding: opts.encoding ?? "utf-8" });
  } else {
    writeFileSync(path, content);
  }
  if (opts.mode !== undefined) {
    try { chmodSync(path, opts.mode); } catch { /* best effort */ }
  }
}

function tryUnlink(path: string): void {
  try { unlinkSync(path); } catch { /* ignore */ }
}

/**
 * Atomically write `content` to `path` (tmp + rename, same-filesystem).
 *
 * Errors that come from the final `renameSync` with code `EXDEV`
 * (cross-mount) trigger a non-atomic fallback to `writeFileSync` plus a
 * one-line stderr warning. All other errors propagate.
 */
export function atomicWriteFileSync(
  path: string,
  content: string | Buffer,
  opts: AtomicWriteOptions = {},
): void {
  const dir = dirname(path);
  const suffix = `${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}`;
  const tmpPath = join(dir, `.tmp.${basename(path)}.${suffix}`);

  installExitHandler();
  trackedDirs.add(dir);

  writeWithMode(tmpPath, content, opts);

  try {
    renameSync(tmpPath, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") {
      tryUnlink(tmpPath);
      throw err;
    }
    // Cross-mount rename refused by the kernel. Fall back to a direct
    // write so the caller still makes progress; warn once.
    try {
      writeWithMode(path, content, opts);
    } finally {
      tryUnlink(tmpPath);
    }
    // eslint-disable-next-line no-console
    console.error(
      `atomic-fs: rename across mounts; wrote ${path} non-atomically (EXDEV)`,
    );
  }
}
