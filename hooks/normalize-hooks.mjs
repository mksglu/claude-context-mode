// normalize-hooks.mjs — fixes #378
//
// Static committed files (hooks/hooks.json, .claude-plugin/plugin.json) ship
// with `${CLAUDE_PLUGIN_ROOT}` placeholder + bare `node` command. On Windows
// + Claude Code this triggers cjs/loader:1479 errors because:
//   1. bare `node` may not resolve via PATH (Git Bash, see #369)
//   2. `${CLAUDE_PLUGIN_ROOT}` resolution can hit MSYS path mangling (#372)
//   3. backslash paths get corrupted in shell quoting
//
// Our buildNodeCommand() fix handles dynamically-generated settings.json but
// not the static committed files. Solution: start.mjs detects the placeholder
// pattern on every MCP boot and rewrites with absolute paths using
// process.execPath + forward slashes. Idempotent — only rewrites when needed.
// Survives upgrades because it runs at every start.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";

// #604: matches a cache path segment `context-mode/context-mode/<version>`.
// Capture group is the X.Y.Z version. Used to detect command paths frozen on a
// previous-version dir that Claude Code's native plugin manager has since
// cleaned up. `/g` so a single content blob with multiple stale references is
// fully covered. Forward-slash only — callers convert beforehand.
const CACHE_VERSION_RE =
  /context-mode\/context-mode\/([0-9]+\.[0-9]+\.[0-9]+)(?=\/)/g;

/** Convert any path string to forward slashes (MSYS-safe). */
function fwd(p) {
  return String(p).replace(/\\/g, "/");
}

/**
 * Extract the X.Y.Z version segment from a pluginRoot under the context-mode
 * cache layout. Returns null when running from npm-global, a dev checkout, or
 * any layout that does not match the `<…>/context-mode/context-mode/<v>(/…)?`
 * pattern — callers must treat null as "no stale-path check is possible".
 */
function pluginRootVersion(pluginRoot) {
  if (!pluginRoot) return null;
  const m =
    /context-mode\/context-mode\/([0-9]+\.[0-9]+\.[0-9]+)(?:\/|$)/.exec(
      fwd(pluginRoot),
    );
  return m ? m[1] : null;
}

/**
 * Does `content` reference any context-mode cache version segment that differs
 * from `currentVersion`? Detects the #604 ratchet: already-normalized hooks.json
 * / plugin.json carrying a previous version's absolute paths forward into a
 * newer version's cache directory after Claude Code's auto-update.
 */
function hasStaleCacheVersionSegment(content, currentVersion) {
  if (!currentVersion || !content || typeof content !== "string") return false;
  const safe = fwd(content);
  CACHE_VERSION_RE.lastIndex = 0;
  let m;
  while ((m = CACHE_VERSION_RE.exec(safe)) !== null) {
    if (m[1] !== currentVersion) return true;
  }
  return false;
}

/**
 * Pure detection: does this content need to be (re-)normalized?
 *
 * Two triggers:
 *   1. Fresh content still containing the `${CLAUDE_PLUGIN_ROOT}` placeholder
 *      — the original #378 first-boot path on any host.
 *   2. (#604) Already-resolved content whose absolute paths point at a
 *      different version of the context-mode cache than the current
 *      `pluginRoot`. Breaks the ratchet that previously froze stale paths
 *      after Claude Code's native plugin manager copied a previous version's
 *      hooks.json forward.
 *
 * `pluginRoot` is optional for backwards compatibility with single-arg
 * callers; without it, only the placeholder check runs.
 */
export function needsHookNormalization(content, pluginRoot) {
  if (!content || typeof content !== "string") return false;
  if (content.includes(PLACEHOLDER)) return true;
  return hasStaleCacheVersionSegment(content, pluginRootVersion(pluginRoot));
}

/**
 * Rewrite hooks.json content. Replaces:
 *   - `node "${CLAUDE_PLUGIN_ROOT}/x.mjs"` →
 *     `"<execPath>" "<pluginRoot>/x.mjs"`  (forward slashes, double-quoted)
 *
 * Pure function — takes content + paths, returns new content.
 * Idempotent — leaves already-normalized content unchanged.
 */
export function normalizeHooksJson(content, nodePath, pluginRoot) {
  if (!needsHookNormalization(content, pluginRoot)) return content;

  const safeNode = fwd(nodePath);
  const safeRoot = fwd(pluginRoot);
  const currentVersion = pluginRootVersion(pluginRoot);

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }

  const hooks = parsed?.hooks;
  if (!hooks || typeof hooks !== "object") return content;

  let mutated = false;
  for (const eventName of Object.keys(hooks)) {
    const matchers = hooks[eventName];
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const inner = matcher?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        if (typeof h?.command !== "string") continue;

        const hasPlaceholder = h.command.includes(PLACEHOLDER);
        // #604: also rewrite when the command holds a stale absolute path under
        // a previous-version cache dir (Claude Code's auto-update ratchet).
        const hasStale = hasStaleCacheVersionSegment(h.command, currentVersion);
        if (!hasPlaceholder && !hasStale) continue;

        let next = h.command;
        if (hasPlaceholder) {
          // Replace placeholder with absolute root (forward-slash).
          next = next.replaceAll(PLACEHOLDER, safeRoot);
          // Replace bare `node ` prefix with quoted execPath. Match both
          // `node ` and `node\t` at start, with optional surrounding whitespace.
          next = next.replace(/^\s*node\s+/, `"${safeNode}" `);
        }
        if (hasStale) {
          // Re-point every `context-mode/context-mode/<old-version>/…` segment
          // to the current pluginRoot's version. Operates on the forward-slash
          // form so MSYS-mangled paths heal as well.
          next = fwd(next).replace(
            CACHE_VERSION_RE,
            `context-mode/context-mode/${currentVersion}`,
          );
        }
        h.command = next;
        mutated = true;
      }
    }
  }

  if (!mutated) return content;

  // Preserve 2-space indent (matches committed format).
  return JSON.stringify(parsed, null, 2);
}

/**
 * Rewrite plugin.json mcpServers. Replaces:
 *   - `command: "node"` → `command: "<execPath-fwd>"`
 *   - `args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs"]` →
 *     `args: ["<pluginRoot-fwd>/start.mjs"]`
 *
 * Idempotent.
 */
export function normalizePluginJson(content, nodePath, pluginRoot) {
  if (!needsHookNormalization(content, pluginRoot)) return content;

  const safeNode = fwd(nodePath);
  const safeRoot = fwd(pluginRoot);
  const currentVersion = pluginRootVersion(pluginRoot);

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }

  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== "object") return content;

  let mutated = false;
  for (const name of Object.keys(servers)) {
    const srv = servers[name];
    if (!srv || typeof srv !== "object") continue;

    if (Array.isArray(srv.args)) {
      const before = srv.args;
      const after = before.map((a) => {
        if (typeof a !== "string") return a;
        let next = a;
        if (next.includes(PLACEHOLDER)) {
          next = next.replaceAll(PLACEHOLDER, safeRoot);
        }
        // #604: same auto-update ratchet hits plugin.json args (see #523).
        if (hasStaleCacheVersionSegment(next, currentVersion)) {
          next = fwd(next).replace(
            CACHE_VERSION_RE,
            `context-mode/context-mode/${currentVersion}`,
          );
        }
        return next;
      });
      if (after.some((v, i) => v !== before[i])) {
        srv.args = after;
        mutated = true;
      }
    }

    if (srv.command === "node" && mutated) {
      // Only swap bare `node` when we also rewrote args — otherwise we'd
      // touch user-customized server entries unrelated to placeholders.
      srv.command = safeNode;
    }
  }

  if (!mutated) return content;
  return JSON.stringify(parsed, null, 2);
}

/**
 * Apply normalization to hooks.json and plugin.json on startup.
 *
 * Options:
 *   - pluginRoot: absolute path to plugin install dir (e.g. __dirname of start.mjs)
 *   - nodePath:   process.execPath
 *   - platform:   process.platform ("win32" and "linux" trigger a write)
 *
 * Best-effort — never throws.
 */
export function normalizeHooksOnStartup({ pluginRoot, nodePath, platform }) {
  // Normalize on Windows (MSYS path mangling, #369/#372/#378) and Linux
  // (bare `node` not in PATH when invoked via /bin/sh, e.g. nvm users).
  // macOS ships a system node so bare `node` resolves reliably there.
  if (platform !== "win32" && platform !== "linux") return;
  if (!pluginRoot || !nodePath) return;

  // hooks/hooks.json
  try {
    const hooksPath = resolve(pluginRoot, "hooks", "hooks.json");
    if (existsSync(hooksPath)) {
      const original = readFileSync(hooksPath, "utf-8");
      if (needsHookNormalization(original, pluginRoot)) {
        const next = normalizeHooksJson(original, nodePath, pluginRoot);
        if (next !== original) {
          writeFileSync(hooksPath, next, "utf-8");
        }
      }
    }
  } catch {
    /* best effort */
  }

  // .claude-plugin/plugin.json
  try {
    const pluginPath = resolve(pluginRoot, ".claude-plugin", "plugin.json");
    if (existsSync(pluginPath)) {
      const original = readFileSync(pluginPath, "utf-8");
      if (needsHookNormalization(original, pluginRoot)) {
        const next = normalizePluginJson(original, nodePath, pluginRoot);
        if (next !== original) {
          writeFileSync(pluginPath, next, "utf-8");
        }
      }
    }
  } catch {
    /* best effort */
  }
}
