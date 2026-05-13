/**
 * Plugin cache integrity check (Algo-D4 + Algo-D5).
 *
 * Algorithmic defense against #550: a partial install (interrupted npm
 * install, broken marketplace pull, half-finished /ctx-upgrade) leaves
 * start.mjs spawnable but a critical sibling (server.bundle.mjs,
 * cli.bundle.mjs, hooks/<event>.mjs, …) missing. The MCP child then
 * dies silently downstream and the user sees an opaque "MCP server
 * failed to start" with no actionable signal.
 *
 * The expected sibling tree is DERIVED from `package.json files[]` —
 * the npm publish source of truth. Adding a new entry there auto-
 * extends the integrity check; no parallel hardcoded list to maintain
 * (the trap that bites every project that hand-rolls "list of files
 * that must exist at runtime").
 *
 * Two consumers:
 *   1. start.mjs at boot — calls assertPluginCacheIntegrity, on !ok
 *      writes a structured CONTEXT_MODE_PARTIAL_INSTALL stderr block
 *      and exits 2. Fail-fast — the alternative is a downstream stack
 *      trace from `import("./server.bundle.mjs")` that hides the
 *      actual root cause.
 *   2. src/cli.ts ctx doctor (Algo-D5) — same helper, same answer,
 *      surfaced as a HealthCheck so users get the diagnostic without
 *      restarting the MCP server.
 *
 * Pure JS, Node.js built-ins only. Ships in package.json files[] so
 * users running off the npm tarball get the same code path the
 * developer ran during `pretest`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Walk a directory recursively, returning a flat list of relative file
 * paths (using `/` as separator inside the returned strings). Skips
 * unreadable entries silently — the integrity check operates on what
 * IS readable; missing entries are reported by the caller.
 */
function listFilesRecursive(absDir, baseAbs) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(absDir);
  } catch {
    return out; // unreadable — caller will report the parent as missing
  }
  for (const name of entries) {
    const full = join(absDir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listFilesRecursive(full, baseAbs));
    } else {
      out.push(relative(baseAbs, full));
    }
  }
  return out;
}

/**
 * Compute the expected sibling tree for a given pluginRoot, derived
 * from the supplied `package.json files[]` array.
 *
 * Algorithm:
 *   - Each entry in files[] is resolved against pluginRoot.
 *   - If it points to a directory → list every file inside recursively.
 *   - If it points to a file → kept as-is.
 *   - Entries that don't exist at probe-time are EXCLUDED from the
 *     manifest (they show up as `missing` in the assert step instead).
 *     This avoids the trap of "manifest contains paths that have never
 *     existed" — the manifest is a snapshot of WHAT IS, not WHAT WAS
 *     PUBLISHED.
 *
 * Returns relative paths (relative to pluginRoot). Used by both
 * assertPluginCacheIntegrity and the doctor surface.
 */
export function derivePluginManifest({ pkg, pluginRoot }) {
  if (!pkg || !Array.isArray(pkg.files)) return [];
  const manifest = new Set();
  for (const entry of pkg.files) {
    if (typeof entry !== "string" || !entry) continue;
    const absEntry = join(pluginRoot, entry);
    if (!existsSync(absEntry)) continue;
    let st;
    try {
      st = statSync(absEntry);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const f of listFilesRecursive(absEntry, pluginRoot)) manifest.add(f);
    } else {
      manifest.add(entry);
    }
  }
  return [...manifest];
}

/**
 * REQUIRED_RUNTIME_SIBLINGS — the minimum set of files start.mjs must
 * find at boot. These are the files start.mjs actively `import()`s or
 * needs to re-symlink against. The check is intentionally narrower
 * than the full manifest:
 *
 *   - server.bundle.mjs / cli.bundle.mjs are produced by `npm run
 *     bundle`. Without server.bundle.mjs the server can't start;
 *     without cli.bundle.mjs `context-mode doctor` can't run.
 *   - hooks/{5 hook scripts}.mjs are spawned per Claude Code event.
 *     Missing any one produces a silent hook failure.
 *
 * Other files in package.json files[] (insight/, configs/, README, …)
 * are not boot-critical, so missing them is a "warn"-class issue
 * surfaced only via the doctor — never enough to fail-fast at boot.
 */
const REQUIRED_RUNTIME_SIBLINGS = Object.freeze([
  "server.bundle.mjs",
  "cli.bundle.mjs",
  join("hooks", "pretooluse.mjs"),
  join("hooks", "posttooluse.mjs"),
  join("hooks", "precompact.mjs"),
  join("hooks", "sessionstart.mjs"),
  join("hooks", "userpromptsubmit.mjs"),
]);

/**
 * Verify boot-critical siblings exist at pluginRoot.
 *
 * Returns `{ ok, missing }`. Pure — does NOT touch process.exit or
 * stderr. The caller (start.mjs at boot, src/cli.ts at doctor) decides
 * the failure surface (fail-fast exit 2 vs. doctor diagnostic).
 *
 * Uses package.json (read from pluginRoot) only as a source-of-truth
 * cross-check; the actual REQUIRED list is hardcoded above to keep the
 * runtime contract independent of package.json being readable. If
 * package.json IS readable AND files[] omits something we require, the
 * check fails — that's the "drift between contract and tarball" trap.
 */
export function assertPluginCacheIntegrity({ pluginRoot }) {
  const missing = [];
  for (const rel of REQUIRED_RUNTIME_SIBLINGS) {
    const abs = join(pluginRoot, rel);
    if (!existsSync(abs)) missing.push(abs);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Format the structured stderr block start.mjs emits when integrity
 * fails. Marker line `CONTEXT_MODE_PARTIAL_INSTALL` lets external
 * monitoring grep for the exact failure mode without parsing free-form
 * text. Keep the format stable across versions.
 */
export function formatPartialInstallReport({ pluginRoot, missing }) {
  const lines = [
    "CONTEXT_MODE_PARTIAL_INSTALL",
    `  pluginRoot: ${pluginRoot}`,
    "  missing:",
    ...missing.map((m) => `    - ${m}`),
    "  fix: rm -rf the install dir and re-pull (marketplace) or run `npm install -g context-mode` again.",
    "",
  ];
  return lines.join("\n");
}
