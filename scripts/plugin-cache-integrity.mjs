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
import { join, relative, sep } from "node:path";

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
 * LEGACY_FALLBACK — the v1.0.126 hardcoded REQUIRED_RUNTIME_SIBLINGS,
 * preserved verbatim. Forms the union seed for the algorithmic set so
 * the post-558 contract is strictly additive over the pre-558 contract
 * (no required sibling ever silently disappears).
 *
 * Also acts as a safety net when `package.json` is unreadable — the
 * boot gate stays loud even if the publish manifest is corrupted.
 */
const LEGACY_FALLBACK = Object.freeze([
  "server.bundle.mjs",
  "cli.bundle.mjs",
  join("hooks", "pretooluse.mjs"),
  join("hooks", "posttooluse.mjs"),
  join("hooks", "precompact.mjs"),
  join("hooks", "sessionstart.mjs"),
  join("hooks", "userpromptsubmit.mjs"),
]);

/**
 * SOFT_FALLBACK_BUNDLES — bundles that already implement
 * bundle-first / build-fallback resolution (via session-loaders.mjs or
 * session-helpers.mjs). Their absence on a published install is
 * gracefully recoverable, so they MUST NOT join the fail-fast boot
 * gate — the gate would refuse to start a working install.
 *
 * The security bundle is intentionally NOT here: its absence creates a
 * silent fail-OPEN regression (#558), so it IS boot-critical.
 */
const SOFT_FALLBACK_BUNDLES = new Set([
  "hooks/session-extract.bundle.mjs",
  "hooks/session-snapshot.bundle.mjs",
  "hooks/session-db.bundle.mjs",
  "hooks/session-attribution.bundle.mjs",
]);

/**
 * Algorithmically extract every esbuild output path from
 * `package.json scripts.bundle`. The bundle script is the SINGLE
 * SOURCE OF TRUTH for "what bundles this build produces" — parsing
 * its `--outfile=…` arguments avoids the parallel-list trap that
 * bit Algo-D4 v1.0.126 (the hardcoded REQUIRED list lagged the
 * actual bundle output).
 *
 * Returns POSIX-style relative paths (forward slashes) for stable
 * comparison with SOFT_FALLBACK_BUNDLES. Caller normalizes to
 * `path.join` shape before pluginRoot-relative resolution.
 */
function extractBundleOutfiles(pkg) {
  const script = pkg?.scripts?.bundle;
  if (typeof script !== "string") return [];
  const out = new Set();
  // Match every `--outfile=<path>` token (path is whitespace-delimited
  // because the script chains commands with `&&`).
  const re = /--outfile=(\S+)/g;
  let m;
  while ((m = re.exec(script)) !== null) {
    out.add(m[1]);
  }
  return [...out];
}

/**
 * Algorithmic — derive the boot-critical sibling set as the union of:
 *   1. LEGACY_FALLBACK (the v1.0.126 contract, preserved verbatim).
 *   2. Every esbuild output path from `package.json scripts.bundle`
 *      that is NOT in SOFT_FALLBACK_BUNDLES.
 *
 * Why algorithmic instead of hardcoded:
 *
 *   v1.0.126 shipped Algo-D4 with a hardcoded REQUIRED_RUNTIME_SIBLINGS
 *   array that omitted `hooks/security.bundle.mjs` (the bundle didn't
 *   ship until v1.0.127). The hardcoded list would need manual
 *   extension every time a runtime bundle is added — the same trap
 *   would re-bite the next bundle. Deriving from `scripts.bundle`
 *   closes the trap: any new bundle output is auto-gated unless it
 *   joins the soft-fallback whitelist (which is itself an explicit
 *   architectural decision, not a maintenance burden). (#558)
 *
 * Returns OS-native-separator relative paths (suitable for
 * `path.join(pluginRoot, …)`).
 *
 * If `package.json` is unreadable, returns LEGACY_FALLBACK as a
 * safety net so the boot gate never goes silent due to a parse
 * error in the publish manifest.
 */
export function getRequiredRuntimeSiblings(pluginRoot) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf-8"));
  } catch {
    return [...LEGACY_FALLBACK];
  }
  const required = new Set(LEGACY_FALLBACK);
  for (const outfile of extractBundleOutfiles(pkg)) {
    // Normalize to POSIX for soft-fallback membership check —
    // scripts.bundle is hand-authored with forward slashes already,
    // but be defensive in case a Windows-authored package.json ever
    // reaches us.
    const posix = outfile.split(sep).join("/");
    if (SOFT_FALLBACK_BUNDLES.has(posix)) continue;
    // Convert back to OS-native sep for downstream filesystem ops.
    required.add(posix.split("/").join(sep));
  }
  return [...required];
}

/**
 * Verify boot-critical siblings exist at pluginRoot.
 *
 * Returns `{ ok, missing }`. Pure — does NOT touch process.exit or
 * stderr. The caller (start.mjs at boot, src/cli.ts at doctor) decides
 * the failure surface (fail-fast exit 2 vs. doctor diagnostic).
 *
 * Required-set is computed by `getRequiredRuntimeSiblings()` —
 * algorithmically derived from `package.json files[]` filtered to the
 * RUNTIME_CRITICAL_PATTERN. Drift between publish manifest and runtime
 * contract becomes architecturally impossible (#558).
 */
export function assertPluginCacheIntegrity({ pluginRoot }) {
  const missing = [];
  for (const rel of getRequiredRuntimeSiblings(pluginRoot)) {
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
