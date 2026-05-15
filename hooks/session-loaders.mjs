/**
 * Session module loaders — bundle-first with build/ fallback.
 *
 * All session modules are loaded from esbuild bundles (hooks/session-*.bundle.mjs).
 * Bundles are built by CI (bundle.yml) and shipped with every release.
 * Fallback: if bundles are missing (marketplace installs), try build/session/*.js.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

export function createSessionLoaders(hookDir) {
  // Auto-detect bundle directory: bundles live in hooks/ root, not platform subdirs.
  // If hookDir itself has bundles, use it; otherwise go up one level.
  const bundleDir = existsSync(join(hookDir, "session-db.bundle.mjs"))
    ? hookDir
    : join(hookDir, "..");

  // Fallback: if bundles missing, try build/session/*.js (marketplace installs)
  const pluginRoot = join(bundleDir, "..");
  const buildSession = join(pluginRoot, "build", "session");

  async function loadModule(bundleName, buildName) {
    const bundlePath = join(bundleDir, bundleName);
    if (existsSync(bundlePath)) {
      return await import(pathToFileURL(bundlePath).href);
    }
    const buildPath = join(buildSession, buildName);
    return await import(pathToFileURL(buildPath).href);
  }

  return {
    async loadSessionDB() {
      return await loadModule("session-db.bundle.mjs", "db.js");
    },
    async loadProjectAttribution() {
      const bundlePath = join(bundleDir, "session-attribution.bundle.mjs");
      if (existsSync(bundlePath)) {
        return await import(pathToFileURL(bundlePath).href);
      }
      const buildPath = join(buildSession, "project-attribution.js");
      if (existsSync(buildPath)) {
        return await import(pathToFileURL(buildPath).href);
      }
      // Last-resort fallback for dev environments without a fresh build.
      const localPath = join(bundleDir, "project-attribution.mjs");
      return await import(pathToFileURL(localPath).href);
    },
    async loadExtract() {
      return await loadModule("session-extract.bundle.mjs", "extract.js");
    },
    async loadSnapshot() {
      return await loadModule("session-snapshot.bundle.mjs", "snapshot.js");
    },
  };
}

/**
 * Shared helper — resolves project attributions and inserts events into the DB.
 * Eliminates the ~15-line attribution block duplicated across all hook files.
 *
 * @returns {Array} The resolved attributions array (useful when a subsequent
 *   attribution block needs `lastKnownProjectDir` from the first).
 */
export function attributeAndInsertEvents(db, sessionId, events, input, projectDir, hookName, resolveProjectAttributions) {
  const sessionStats = db.getSessionStats(sessionId);
  const lastKnownProjectDir = typeof db.getLatestAttributedProjectDir === "function"
    ? db.getLatestAttributedProjectDir(sessionId)
    : null;
  const attributions = resolveProjectAttributions(events, {
    sessionOriginDir: sessionStats?.project_dir || projectDir,
    inputProjectDir: projectDir,
    workspaceRoots: Array.isArray(input.workspace_roots) ? input.workspace_roots : [],
    lastKnownProjectDir,
  });
  // Build a parallel bytesList from event-level bytes_avoided (currently
  // populated by external_ref's ctx_fetch_and_index preamble parser). When
  // no event carries a positive value we leave bytesList undefined so
  // SessionDB falls back to its 0-default for bytes_avoided/bytes_returned
  // — preserves backward compat with older callers / tests.
  let bytesList;
  if (events.some((e) => typeof e?.bytes_avoided === "number" && e.bytes_avoided > 0)) {
    bytesList = events.map((e) =>
      typeof e?.bytes_avoided === "number" && e.bytes_avoided > 0
        ? { bytesAvoided: e.bytes_avoided }
        : undefined,
    );
  }
  // Prefer bulk path (single transaction = single WAL commit). Falls back
  // to per-event insert for older SessionDB instances that lack bulkInsertEvents.
  if (typeof db.bulkInsertEvents === "function") {
    db.bulkInsertEvents(sessionId, events, hookName, attributions, bytesList);
  } else {
    for (let i = 0; i < events.length; i++) {
      db.insertEvent(sessionId, events[i], hookName, attributions[i], bytesList?.[i]);
    }
  }
  return attributions;
}
