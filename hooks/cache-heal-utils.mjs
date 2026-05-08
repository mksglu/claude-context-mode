// cache-heal-utils.mjs — fixes Brew-node-upgrade stale path bug
//
// Problem: start.mjs writes process.execPath into ~/.claude/settings.json
// when registering the cache-heal hook. On Brew, process.execPath returns
// the *versioned* Cellar snapshot:
//
//   /opt/homebrew/Cellar/node/25.9.0_2/bin/node
//
// When Brew upgrades Node, that path disappears and Claude fails to spawn
// the hook ("session start" error). The stable symlink is:
//
//   /opt/homebrew/bin/node
//
// Fix is two layered:
//   A) New installs on Unix: write hook script with `#!/usr/bin/env node`
//      shebang + chmod +x, register hook command as the bare script path.
//      `env` resolves node from PATH at runtime — survives any Node upgrade.
//      Windows keeps the explicit-execPath form (no shebang support).
//   B) Self-heal: every MCP boot, scan ~/.claude/settings.json for an
//      existing cache-heal hook command whose leading node path no longer
//      exists. If stale, rewrite using pattern (A).
//
// This module is pure (no global state) and side-effect free except for
// the explicit selfHealCacheHealHook() entry point that touches disk.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
} from "node:fs";

/**
 * Convert any path string to forward slashes (matches normalize-hooks style,
 * keeps round-trips on Windows safe).
 */
function fwd(p) {
  return String(p).replace(/\\/g, "/");
}

/**
 * Extract the leading executable path from a hook command string IF it
 * looks like a node binary. Returns null when the command is shebang-style
 * (bare script path) or when the leading executable isn't node.
 *
 * Accepted shapes:
 *   '"/abs/path/to/node" "/abs/path/script.mjs"'
 *   '/abs/path/to/node "/abs/path/script.mjs"' (unquoted node)
 *
 * Returns null for:
 *   '"/abs/path/script.mjs"'                    (shebang form)
 *   '"/usr/bin/python3" "/abs/path/script.py"'  (not node)
 */
export function extractNodePath(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  const trimmed = cmd.trim();
  if (!trimmed) return null;

  // Match: optional quote, capture path until matching quote or whitespace.
  let leading;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end === -1) return null;
    leading = trimmed.slice(1, end);
  } else {
    const end = trimmed.search(/\s/);
    leading = end === -1 ? trimmed : trimmed.slice(0, end);
  }

  if (!leading) return null;

  // Only treat as a node path if the basename is a node binary.
  // Match: "node", "node.exe" (case-insensitive on Windows-style names).
  const base = leading.split(/[\\/]/).pop() ?? "";
  if (!/^node(\.exe)?$/i.test(base)) return null;

  return leading;
}

/**
 * True when the hook command's leading node path no longer exists on disk.
 * Returns false for shebang-style commands (no node prefix to validate).
 */
export function isStaleNodePath(cmd) {
  const nodePath = extractNodePath(cmd);
  if (!nodePath) return false;
  try {
    return !existsSync(nodePath);
  } catch {
    return false;
  }
}

/**
 * Build a cross-platform hook command for the cache-heal script.
 *
 * On Unix (anything except win32):
 *   - Returns just the script path (double-quoted), e.g. '"/path/to/script.mjs"'
 *   - Caller MUST ensure the script has `#!/usr/bin/env node` shebang and
 *     chmod 0o755.
 *   - `env` resolves node from PATH at runtime → survives Brew/asdf/nvm
 *     upgrades.
 *
 * On Windows:
 *   - Returns '"<nodePath>" "<scriptPath>"' (forward slashes, both quoted).
 *   - Windows has no shebang support; we must invoke node explicitly.
 */
export function buildHookCommand({ scriptPath, platform, nodePath }) {
  if (!scriptPath || typeof scriptPath !== "string") {
    throw new TypeError("buildHookCommand: scriptPath is required");
  }
  const safeScript = fwd(scriptPath);
  if (platform === "win32") {
    if (!nodePath || typeof nodePath !== "string") {
      throw new TypeError(
        "buildHookCommand: nodePath is required on win32",
      );
    }
    const safeNode = fwd(nodePath);
    return `"${safeNode}" "${safeScript}"`;
  }
  return `"${safeScript}"`;
}

/**
 * Self-heal step for ~/.claude/settings.json.
 *
 * - Looks at SessionStart hooks for any registered cache-heal hook.
 * - If its command has a stale node path (Brew upgrade scenario),
 *   rewrites the command using buildHookCommand() — Unix gets shebang
 *   form, Windows gets explicit nodePath form.
 * - No-op when:
 *     * settings.json doesn't exist
 *     * no cache-heal hook is registered
 *     * the hook command is already valid (path exists or shebang form)
 * - On Unix, also re-asserts the script's shebang + chmod +x so a healed
 *   command actually works.
 *
 * Returns: one of "noop" | "healed" | "missing-settings" — useful for
 * tests and telemetry.
 *
 * Best-effort — all I/O is wrapped; never throws.
 */
export function selfHealCacheHealHook({
  settingsPath,
  scriptPath,
  platform,
  nodePath,
}) {
  if (!settingsPath || !existsSync(settingsPath)) return "missing-settings";

  let raw;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch {
    return "noop";
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "noop";
  }

  const hooks = parsed?.hooks;
  if (!hooks || typeof hooks !== "object") return "noop";
  const sessionStart = Array.isArray(hooks.SessionStart)
    ? hooks.SessionStart
    : null;
  if (!sessionStart) return "noop";

  let healed = false;
  for (const matcher of sessionStart) {
    const inner = matcher?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (typeof h?.command !== "string") continue;
      if (!h.command.includes("context-mode-cache-heal")) continue;
      if (!isStaleNodePath(h.command)) continue;

      // Stale → rewrite.
      h.command = buildHookCommand({ scriptPath, platform, nodePath });
      healed = true;
    }
  }

  if (!healed) return "noop";

  // Unix: re-assert shebang + chmod so the bare-script command works.
  if (platform !== "win32" && scriptPath && existsSync(scriptPath)) {
    try {
      ensureShebangAndExecBit(scriptPath);
    } catch {
      /* best effort */
    }
  }

  try {
    writeFileSync(
      settingsPath,
      JSON.stringify(parsed, null, 2) + "\n",
      "utf-8",
    );
  } catch {
    return "noop";
  }
  return "healed";
}

/**
 * Ensure a script starts with `#!/usr/bin/env node` and has 0o755 mode.
 * Idempotent — leaves correctly-shebanged scripts unchanged.
 */
export function ensureShebangAndExecBit(scriptPath) {
  if (!scriptPath || !existsSync(scriptPath)) return;
  try {
    const content = readFileSync(scriptPath, "utf-8");
    if (!content.startsWith("#!")) {
      writeFileSync(scriptPath, `#!/usr/bin/env node\n${content}`, "utf-8");
    }
    // statSync().mode lower 9 bits = perms.
    const mode = statSync(scriptPath).mode & 0o777;
    if (mode !== 0o755) {
      chmodSync(scriptPath, 0o755);
    }
  } catch {
    /* best effort */
  }
}
