/**
 * Platform detection from process env vars.
 *
 * Each supported platform sets a distinctive env var when invoking
 * hook scripts; we use those to pick the correct tool-namer prefix
 * and routing block. Falls back to "claude-code" when nothing matches
 * so existing CC behavior is preserved.
 *
 * SINGLE SOURCE OF TRUTH: this table mirrors `PLATFORM_ENV_VARS` in
 * `src/adapters/detect.ts:33-77`. Every entry has been verified against
 * the platform's own runtime source code (full audit May 2026, see
 * git blame). DO NOT add platform env vars here that aren't also in
 * detect.ts — the two MUST stay in lock-step or detection will diverge
 * between MCP-server-side and hook-script-side.
 *
 * Order matters — same as detect.ts. Forks listed BEFORE the fork's
 * parent so collision detection works (e.g. cursor BEFORE vscode-copilot
 * because Cursor inherits VSCODE_PID as a fork; antigravity BEFORE
 * vscode-copilot for the same reason).
 */

// Mirror of `PLATFORM_ENV_VARS` in src/adapters/detect.ts:33-77.
// Keep in lock-step. If you change one, change the other.
const PLATFORM_ENV_VARS_MIRROR = [
  ["claude-code",        ["CLAUDE_PROJECT_DIR", "CLAUDE_SESSION_ID"]],
  ["antigravity",        ["ANTIGRAVITY_CLI_ALIAS"]],
  ["cursor",             ["CURSOR_TRACE_ID", "CURSOR_CLI"]],
  ["kilo",               ["KILO_PID"]],
  ["opencode",           ["OPENCODE", "OPENCODE_PID"]],
  ["zed",                ["ZED_SESSION_ID", "ZED_TERM"]],
  ["codex",              ["CODEX_THREAD_ID", "CODEX_CI"]],
  ["gemini-cli",         ["GEMINI_PROJECT_DIR", "GEMINI_CLI"]],
  ["vscode-copilot",     ["VSCODE_PID", "VSCODE_CWD"]],
  ["jetbrains-copilot",  ["IDEA_INITIAL_DIRECTORY"]],
  ["qwen-code",          ["QWEN_PROJECT_DIR"]],
  ["pi",                 ["PI_PROJECT_DIR"]],
  // openclaw — no auto-set process env vars; falls through to default
  // kiro — no auto-set process env vars; falls through to default
];

export function detectPlatformFromEnv(env = process.env) {
  for (const [platform, vars] of PLATFORM_ENV_VARS_MIRROR) {
    if (vars.some((v) => env[v])) return platform;
  }
  return "claude-code";
}

// Re-exported for tests so they can assert against the same canonical table.
export { PLATFORM_ENV_VARS_MIRROR };
