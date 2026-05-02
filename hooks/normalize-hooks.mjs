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

/** Convert any path string to forward slashes (MSYS-safe). */
function fwd(p) {
  return String(p).replace(/\\/g, "/");
}

/**
 * Pure detection: does this content contain an unresolved CLAUDE_PLUGIN_ROOT
 * placeholder that should be normalized?
 */
export function needsHookNormalization(content) {
  if (!content || typeof content !== "string") return false;
  return content.includes(PLACEHOLDER);
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
  if (!needsHookNormalization(content)) return content;

  const safeNode = fwd(nodePath);
  const safeRoot = fwd(pluginRoot);

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
        if (!h.command.includes(PLACEHOLDER)) continue;
        // Replace placeholder with absolute root (forward-slash).
        let next = h.command.replaceAll(PLACEHOLDER, safeRoot);
        // Replace bare `node ` prefix with quoted execPath. Match both
        // `node ` and `node\t` at start, with optional surrounding whitespace.
        next = next.replace(/^\s*node\s+/, `"${safeNode}" `);
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
  if (!needsHookNormalization(content)) return content;

  const safeNode = fwd(nodePath);
  const safeRoot = fwd(pluginRoot);

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
        typeof a === "string" && a.includes(PLACEHOLDER)
          ? a.replaceAll(PLACEHOLDER, safeRoot)
          : a,
      );
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
 *   - platform:   process.platform (only "win32" triggers a write)
 *
 * Best-effort — never throws.
 */
export function normalizeHooksOnStartup({ pluginRoot, nodePath, platform }) {
  if (platform !== "win32") return;
  if (!pluginRoot || !nodePath) return;

  // hooks/hooks.json
  try {
    const hooksPath = resolve(pluginRoot, "hooks", "hooks.json");
    if (existsSync(hooksPath)) {
      const original = readFileSync(hooksPath, "utf-8");
      if (needsHookNormalization(original)) {
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
      if (needsHookNormalization(original)) {
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
