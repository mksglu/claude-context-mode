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
import { createRequire } from "node:module";

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
 * Lazy import of `./adapters/detect.js` keeps this file free of any direct
 * adapter dependency: the detect module itself only `import type`s adapter
 * types at the top level (concrete adapters are loaded dynamically inside
 * `getAdapter()`), so a static import is safe — but we use `createRequire`
 * to make the dependency direction crystal clear and to avoid surprising
 * future maintainers who add eager adapter imports to detect.ts.
 *
 * The returned array is deduplicated and order-stable: adapter-specific path
 * first (most specific), claude global second (fallback).
 */
export function resolveAdapterGlobalSettingsPaths(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const paths: string[] = [];

  // Lazy-load detect module to avoid any chance of an adapter import cycle.
  // `detect.ts` exports pure functions — `detectPlatform` (env-driven) and
  // `getSessionDirSegments` (sync map). Neither instantiates an adapter.
  let detected: { platform: string } | null = null;
  let segmentsFor: ((p: string) => string[] | null) | null = null;
  try {
    const lazyRequire = createRequire(import.meta.url);
    const detect = lazyRequire("../adapters/detect.js") as {
      detectPlatform: () => { platform: string };
      getSessionDirSegments: (p: string) => string[] | null;
    };
    detected = detect.detectPlatform();
    segmentsFor = detect.getSessionDirSegments;
  } catch {
    // If detection fails for any reason, fall back to claude-only behavior.
  }

  if (detected && segmentsFor && detected.platform !== "claude-code") {
    const segments = segmentsFor(detected.platform);
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
