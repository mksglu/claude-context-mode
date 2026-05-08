/**
 * Suppress stderr at the OS file descriptor level.
 *
 * Native C++ modules (better-sqlite3) write directly to fd 2 during
 * initialization, bypassing Node.js process.stderr. Platforms like
 * Claude Code interpret ANY stderr output as hook failure.
 *
 * This module MUST be the first import in every hook entry point.
 * ESM evaluates imports depth-first in declaration order, so importing
 * this module first ensures fd 2 is redirected to /dev/null before
 * any native modules are loaded.
 *
 * Cross-platform: os.devNull → /dev/null (Unix) or \\.\NUL (Windows).
 * See: https://github.com/mksglu/context-mode/issues/68
 */
import { closeSync, openSync } from "node:fs";
import { devNull } from "node:os";

try {
  closeSync(2);
  openSync(devNull, "w"); // Acquires fd 2 (lowest available)
} catch {
  // Fallback: suppress at Node.js stream level
  process.stderr.write = /** @type {any} */ (() => true);
}
