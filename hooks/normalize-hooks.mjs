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
const STALE_PLUGIN_ROOT_RE =
  /(?:[A-Za-z]:)?\/?[^"'\s]*\/\.claude\/plugins\/(?:cache\/[^/"'\s]+\/[^/"'\s]+\/[^/"'\s]+|marketplaces\/[^/"'\s]+)/g;

/** Convert any path string to forward slashes (MSYS-safe). */
function fwd(p) {
  return String(p).replace(/\\/g, "/");
}

/**
 * Pure detection: does this content contain an unresolved CLAUDE_PLUGIN_ROOT
 * placeholder or stale absolute plugin-cache path that should be normalized?
 */
export function needsHookNormalization(content, pluginRoot) {
  if (!content || typeof content !== "string") return false;
  if (content.includes(PLACEHOLDER)) return true;
  const safeRoot = pluginRoot ? fwd(pluginRoot) : "";
  const matches = fwd(content).match(STALE_PLUGIN_ROOT_RE) ?? [];
  return matches.some((m) => !safeRoot || m !== safeRoot);
}

function replacePluginRootRefs(value, safeRoot) {
  return fwd(value)
    .replaceAll(PLACEHOLDER, safeRoot)
    .replace(STALE_PLUGIN_ROOT_RE, safeRoot);
}

/**
 * Rewrite hooks.json content. Replaces:
 *   - `node "${CLAUDE_PLUGIN_ROOT}/x.mjs"` →
 *     `"<execPath>" "<pluginRoot>/x.mjs"`  (forward slashes, double-quoted)
 *
 * Pure function — takes content + paths, returns new content.
 * Idempotent — leaves already-normalized content unchanged.
 */
export function normalizeHooksJson(content, nodePath, pluginRoot, opts = {}) {
  if (!needsHookNormalization(content, pluginRoot)) return content;

  const safeNode = fwd(nodePath);
  const safeRoot = fwd(pluginRoot);
  const rewriteNodeCommand = opts.rewriteNodeCommand !== false;

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
        const nextRoot = replacePluginRootRefs(h.command, safeRoot);
        if (nextRoot === h.command) continue;
        // Replace placeholder with absolute root (forward-slash).
        let next = nextRoot;
        // Replace bare `node ` prefix with quoted execPath. Match both
        // `node ` and `node\t` at start, with optional surrounding whitespace.
        if (rewriteNodeCommand) {
          next = next.replace(/^\s*node\s+/, `"${safeNode}" `);
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
export function normalizePluginJson(content, nodePath, pluginRoot, opts = {}) {
  if (!needsHookNormalization(content, pluginRoot)) return content;

  const safeNode = fwd(nodePath);
  const safeRoot = fwd(pluginRoot);
  const rewriteNodeCommand = opts.rewriteNodeCommand !== false;

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
      const after = before.map((a) =>
        typeof a === "string"
          ? replacePluginRootRefs(a, safeRoot)
          : a,
      );
      if (after.some((v, i) => v !== before[i])) {
        srv.args = after;
        mutated = true;
      }
    }

    if (rewriteNodeCommand && srv.command === "node" && mutated) {
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
 *   - platform:   process.platform ("win32" and "linux" rewrite bare `node`)
 *
 * Best-effort — never throws.
 */
export function normalizeHooksOnStartup({ pluginRoot, nodePath, platform }) {
  if (!pluginRoot || !nodePath) return;
  const rewriteNodeCommand = platform === "win32" || platform === "linux";

  // hooks/hooks.json
  try {
    const hooksPath = resolve(pluginRoot, "hooks", "hooks.json");
    if (existsSync(hooksPath)) {
      const original = readFileSync(hooksPath, "utf-8");
      if (needsHookNormalization(original, pluginRoot)) {
        const next = normalizeHooksJson(original, nodePath, pluginRoot, { rewriteNodeCommand });
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
        const next = normalizePluginJson(original, nodePath, pluginRoot, { rewriteNodeCommand });
        if (next !== original) {
          writeFileSync(pluginPath, next, "utf-8");
        }
      }
    }
  } catch {
    /* best effort */
  }
}
