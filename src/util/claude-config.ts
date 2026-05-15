/**
 * Claude Code config directory resolver — single source of truth.
 *
 * Issue #460 follow-up: every Claude-aware reader (adapters, security policy
 * loader, hook helpers) MUST agree on where global settings live. Hardcoding
 * `~/.claude` in any one reader silently breaks `CLAUDE_CONFIG_DIR` for that
 * code path, producing policy drift that is invisible until a user sets the
 * env var and watches their settings get ignored.
 *
 * Mirrors the contract of `hooks/session-helpers.mjs::resolveConfigDir` and
 * `ClaudeCodeAdapter.getConfigDir`:
 *   - env unset, empty string, or whitespace-only → ~/.claude
 *   - env starts with `~`, `~/`, or `~\` → expanded against homedir()
 *   - otherwise → resolved to absolute (relative paths anchor to cwd)
 *
 * Whitespace guard: shells that quote-pad the env value (`CLAUDE_CONFIG_DIR=" "`)
 * would otherwise resolve to `cwd/<spaces>` — silently writing settings into
 * the project tree. Trim before the truthy check so quote-padding falls back
 * to `~/.claude` like a sane default.
 *
 * Cross-platform note: tilde regex strips a single leading `/` OR `\` so
 * `~\Users\foo` works on Windows. `path.resolve` handles drive-letter joining.
 */
import { resolve } from "node:path";
import { homedir } from "node:os";
import { detectPlatform, getSessionDirSegments } from "../adapters/detect.js";

export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const envVal = env.CLAUDE_CONFIG_DIR;
  if (envVal && envVal.trim() !== "") {
    if (envVal.startsWith("~")) {
      return resolve(homedir(), envVal.replace(/^~[/\\]?/, ""));
    }
    return resolve(envVal);
  }
  return resolve(homedir(), ".claude");
}

/** Resolve the global settings.json path, honoring CLAUDE_CONFIG_DIR. */
export function resolveClaudeGlobalSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(resolveClaudeConfigDir(env), "settings.json");
}

/**
 * Issue #451 round-3: cross-adapter deny-policy parity.
 *
 * `resolveClaudeGlobalSettingsPath` hardcodes the `.claude` segment, so
 * non-Claude adapters (cursor, codex, qwen-code, gemini-cli, jetbrains-copilot,
 * vscode-copilot, etc.) never had their global settings consulted by the
 * security policy reader. This helper returns the union of:
 *
 *   1. The currently-detected adapter's home-rooted settings.json (when the
 *      adapter is non-claude — claude is already covered by entry 2).
 *   2. The claude global settings.json (always — defense in depth).
 *
 * Static import of `../adapters/detect.js` is safe — detect.ts only imports
 * `node:` builtins, `./types.js` (type-only), and `./client-map.js` (pure
 * data). It does NOT import claude-config back, so no cycle.
 *
 * History: this used `createRequire(import.meta.url).resolve(...)` to lazy-
 * load detect at call time. That pattern requires `require(esm)`, which is
 * flag-gated on Node 22.x before 22.12 (`--experimental-require-module`).
 * CI run 25877550371 on Node 22.5 silently failed every detect.* call —
 * the catch block ate the error and every cross-adapter deny-policy test
 * returned an empty policy list. Static import sidesteps the require(esm)
 * gate entirely, so the same code works on every supported Node version
 * (20.x, 22.5, 22.12+, 24+) without needing the experimental flag.
 *
 * The returned array is deduplicated and order-stable: adapter-specific path
 * first (most specific), claude global second (fallback).
 */
export function resolveAdapterGlobalSettingsPaths(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const paths: string[] = [];

  const detected = detectPlatform();

  if (detected.platform !== "claude-code") {
    const segments = getSessionDirSegments(detected.platform);
    if (segments && segments.length > 0) {
      paths.push(resolve(homedir(), ...segments, "settings.json"));
    }
  }

  // Always include claude global as fallback (defense in depth).
  const claudePath = resolveClaudeGlobalSettingsPath(env);
  if (!paths.includes(claudePath)) {
    paths.push(claudePath);
  }

  return paths;
}
