/**
 * Shared session helpers for context-mode hooks.
 * Used by posttooluse.mjs, precompact.mjs, sessionstart.mjs,
 * and platform-specific hooks (Gemini CLI, VS Code Copilot).
 *
 * All functions accept an optional `opts` parameter for platform-specific
 * configuration. Defaults to Claude Code settings for backward compatibility.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

/**
 * Returns the worktree suffix for session path isolation.
 * Mirrors the logic in src/server.ts — kept in sync manually since
 * hooks run as plain .mjs (no TypeScript build step).
 *
 * Two-level cache:
 *   1. In-process module cache — same hook fire calls this 3× (db,
 *      events, cleanup paths) so cache hits 2 of 3 cold within process.
 *   2. Cross-process marker file in tmpdir keyed by sha256(cwd) — every
 *      Pre/PostToolUse hook is a fresh node fork; without this each fire
 *      pays 12-50ms for `git worktree list` on Linux/macOS, 50-150ms on
 *      Windows where fork+exec is heavier.
 *
 * Marker filename uses sha256(projectDir) so it is alphanumeric — safe across
 * Windows path/filename rules. tmpdir() resolves correctly on all 3 OS.
 */
let _wtCacheInProcess;
function normalizeWorktreePath(path) {
  const normalized = path.replace(/\\/g, "/");
  if (/^\/+$/.test(normalized)) return "/";
  if (/^[A-Za-z]:\/+$/.test(normalized)) return `${normalized.slice(0, 2)}/`;
  return normalized.replace(/\/+$/, "");
}

function gitOutput(projectDir, args) {
  return execFileSync(
    "git",
    ["-C", projectDir, ...args],
    { encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
}

function getCurrentWorktreeRoot(projectDir) {
  const root = gitOutput(projectDir, ["rev-parse", "--show-toplevel"]);
  return root.length > 0 ? normalizeWorktreePath(root) : null;
}

function getMainWorktreeRoot(projectDir) {
  const root = gitOutput(projectDir, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .find((line) => line.startsWith("worktree "))
    ?.replace("worktree ", "")
    ?.trim();
  return root ? normalizeWorktreePath(root) : null;
}

function workTreeMarkerPath(projectDir) {
  const hash = createHash("sha256").update(normalizeWorktreePath(projectDir)).digest("hex").slice(0, 16);
  return join(tmpdir(), `cm-wt-${hash}.txt`);
}

function getWorktreeSuffix(projectDir = process.cwd()) {
  const envSuffix = process.env.CONTEXT_MODE_SESSION_SUFFIX;
  const normalizedProjectDir = normalizeWorktreePath(projectDir);

  if (
    _wtCacheInProcess &&
    _wtCacheInProcess.projectDir === normalizedProjectDir &&
    _wtCacheInProcess.envSuffix === envSuffix
  ) {
    return _wtCacheInProcess.suffix;
  }

  let suffix;
  if (envSuffix !== undefined) {
    suffix = envSuffix ? `__${envSuffix}` : "";
  } else {
    // Try cross-process marker first.
    const markerPath = workTreeMarkerPath(projectDir);
    try {
      suffix = readFileSync(markerPath, "utf-8");
      _wtCacheInProcess = { projectDir: normalizedProjectDir, envSuffix, suffix };
      return suffix;
    } catch {
      // marker missing → compute below
    }

    suffix = "";
    try {
      const currentRoot = getCurrentWorktreeRoot(projectDir);
      const mainRoot = getMainWorktreeRoot(projectDir);
      if (currentRoot && mainRoot && currentRoot !== mainRoot) {
        suffix = `__${createHash("sha256").update(currentRoot).digest("hex").slice(0, 8)}`;
      }
    } catch {
      // git not available or not a git repo — no suffix
    }

    // Best-effort write so subsequent hook forks short-circuit.
    try {
      writeFileSync(markerPath, suffix, "utf-8");
    } catch {
      // tmpdir not writable — degrade gracefully
    }
  }

  _wtCacheInProcess = { projectDir: normalizedProjectDir, envSuffix, suffix };
  return suffix;
}

/** Claude Code platform options (default). */
const CLAUDE_OPTS = {
  configDir: ".claude",
  configDirEnv: "CLAUDE_CONFIG_DIR",
  projectDirEnv: "CLAUDE_PROJECT_DIR",
  sessionIdEnv: "CLAUDE_SESSION_ID",
};

/** Gemini CLI platform options. */
export const GEMINI_OPTS = {
  configDir: ".gemini",
  configDirEnv: "GEMINI_CLI_HOME",
  projectDirEnv: "GEMINI_PROJECT_DIR",
  sessionIdEnv: undefined,
};

/** VS Code Copilot platform options. */
export const VSCODE_OPTS = {
  configDir: ".vscode",
  configDirEnv: undefined,
  projectDirEnv: "VSCODE_CWD",
  sessionIdEnv: undefined,
};

/** Cursor platform options. */
export const CURSOR_OPTS = {
  configDir: ".cursor",
  configDirEnv: undefined,
  projectDirEnv: "CURSOR_CWD",
  sessionIdEnv: "CURSOR_SESSION_ID",
};

/** Codex CLI platform options. */
export const CODEX_OPTS = {
  configDir: ".codex",
  configDirEnv: "CODEX_HOME",
  projectDirEnv: undefined,   // Codex passes cwd in hook stdin, no env var
  sessionIdEnv: undefined,    // Uses session_id from hook stdin or ppid fallback
};

/** Kiro CLI platform options. */
export const KIRO_OPTS = {
  configDir: ".kiro",
  configDirEnv: undefined,
  projectDirEnv: undefined,   // Kiro CLI provides cwd in hook stdin, no env var
  sessionIdEnv: undefined,    // No session ID env var — uses ppid fallback
};

/** JetBrains Copilot platform options. */
export const JETBRAINS_OPTS = {
  configDir: ".config/JetBrains",
  configDirEnv: undefined,
  projectDirEnv: "IDEA_INITIAL_DIRECTORY",
  sessionIdEnv: undefined,
};

/**
 * Resolve the platform config directory, respecting env var overrides.
 * Platforms like Claude Code (CLAUDE_CONFIG_DIR), Gemini CLI (GEMINI_CLI_HOME),
 * and Codex CLI (CODEX_HOME) allow users to customize the config location.
 * Falls back to ~/<configDir> when no env var is set.
 */
export function resolveConfigDir(opts = CLAUDE_OPTS) {
  if (opts.configDirEnv) {
    const envVal = process.env[opts.configDirEnv];
    if (envVal) {
      if (envVal.startsWith("~")) return join(homedir(), envVal.replace(/^~[/\\]?/, ""));
      return envVal;
    }
  }
  return join(homedir(), opts.configDir);
}

/**
 * Safely parse raw stdin string as JSON.
 * Returns empty object for empty/whitespace/BOM-only input instead of throwing.
 * Strips BOM prefix before parsing. Throws on genuinely malformed JSON.
 */
export function parseStdin(raw) {
  const cleaned = raw.replace(/^\uFEFF/, "").trim();
  return cleaned ? JSON.parse(cleaned) : {};
}

/**
 * Read all of stdin as a string (event-based, cross-platform safe).
 */
export function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data.replace(/^\uFEFF/, "")));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

/**
 * Get the project directory for the current platform.
 * Uses the platform-specific env var, falls back to cwd.
 */
export function getProjectDir(opts = CLAUDE_OPTS) {
  return process.env[opts.projectDirEnv] || process.cwd();
}

/**
 * Get the project directory from hook input when available.
 * Falls back to the platform env var and finally process.cwd().
 */
export function getInputProjectDir(input, opts = CLAUDE_OPTS) {
  if (typeof input?.cwd === "string" && input.cwd.length > 0) {
    return input.cwd;
  }
  if (Array.isArray(input?.workspace_roots) && input.workspace_roots.length > 0) {
    return String(input.workspace_roots[0]);
  }
  return getProjectDir(opts);
}

/**
 * Derive session ID from hook input.
 * Priority: transcript_path UUID > sessionId (camelCase) > session_id > env var > ppid fallback.
 */
export function getSessionId(input, opts = CLAUDE_OPTS) {
  if (input.transcript_path) {
    const match = input.transcript_path.match(/([a-f0-9-]{36})\.jsonl$/);
    if (match) return match[1];
  }
  if (input.conversation_id) return input.conversation_id;
  if (input.sessionId) return input.sessionId;
  if (input.session_id) return input.session_id;
  if (opts.sessionIdEnv && process.env[opts.sessionIdEnv]) {
    return process.env[opts.sessionIdEnv];
  }
  return `pid-${process.ppid}`;
}

/**
 * Return the per-project session DB path.
 * Creates the directory if it doesn't exist.
 * Path: ~/<configDir>/context-mode/sessions/<SHA256(projectDir)[:16]>.db
 */
export function getSessionDBPath(opts = CLAUDE_OPTS, projectDirOverride) {
  const projectDir = normalizeWorktreePath(projectDirOverride ?? getProjectDir(opts));
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  const dir = join(resolveConfigDir(opts), "context-mode", "sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}${getWorktreeSuffix(projectDir)}.db`);
}

/**
 * Return the per-project session events file path.
 * Used by sessionstart hook (write) and MCP server (read + auto-index).
 * Path: ~/<configDir>/context-mode/sessions/<SHA256(projectDir)[:16]>-events.md
 */
export function getSessionEventsPath(opts = CLAUDE_OPTS, projectDirOverride) {
  const projectDir = normalizeWorktreePath(projectDirOverride ?? getProjectDir(opts));
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  const dir = join(resolveConfigDir(opts), "context-mode", "sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}${getWorktreeSuffix(projectDir)}-events.md`);
}

/**
 * Return the per-project cleanup flag path.
 * Used to detect true fresh starts vs --continue (which fires startup+resume).
 * Path: ~/<configDir>/context-mode/sessions/<SHA256(projectDir)[:16]>.cleanup
 */
export function getCleanupFlagPath(opts = CLAUDE_OPTS, projectDirOverride) {
  const projectDir = normalizeWorktreePath(projectDirOverride ?? getProjectDir(opts));
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  const dir = join(resolveConfigDir(opts), "context-mode", "sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}${getWorktreeSuffix(projectDir)}.cleanup`);
}
