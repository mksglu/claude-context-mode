/**
 * Session module loaders — bundle-only.
 *
 * All session modules are loaded from esbuild bundles (hooks/session-*.bundle.mjs).
 * Bundles are built by CI (bundle.yml) and shipped with every release.
 * No fallback to build/ — if the bundle is missing, the error surfaces immediately.
 */

import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";

export function createSessionLoaders(hookDir) {
  const bundleDir = basename(hookDir) === "vscode-copilot"
    ? join(hookDir, "..")
    : hookDir;

  return {
    async loadSessionDB() {
      return await import(pathToFileURL(join(bundleDir, "session-db.bundle.mjs")).href);
    },
    async loadExtract() {
      return await import(pathToFileURL(join(bundleDir, "session-extract.bundle.mjs")).href);
    },
    async loadSnapshot() {
      return await import(pathToFileURL(join(bundleDir, "session-snapshot.bundle.mjs")).href);
    },
  };
}
