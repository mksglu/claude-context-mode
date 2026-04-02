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
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Returns the worktree suffix for session path isolation.
 * Mirrors the logic in src/server.ts — kept in sync manually since
 * hooks run as plain .mjs (no TypeScript build step).
 */
function getWorktreeSuffix() {
  const envSuffix = process.env.CONTEXT_MODE_SESSION_SUFFIX;
  if (envSuffix !== undefined) {
    return envSuffix ? `__${envSuffix}` : "";
  }
  try {
    const cwd = process.cwd();
    const mainWorktree = execFileSync(
      "git",
      ["worktree", "list", "--porcelain"],
      { encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    )
      .split(/\r?\n/)
      .find((l) => l.startsWith("worktree "))
      ?.replace("worktree ", "")
      ?.trim();
    if (mainWorktree && cwd !== mainWorktree) {
      return `__${createHash("sha256").update(cwd).digest("hex").slice(0, 8)}`;
    }
  } catch {
    // git not available or not a git repo — no suffix
  }
  return "";
}

/** Claude Code platform options (default). */
const CLAUDE_OPTS = {
  configDir: ".claude",
  projectDirEnv: "CLAUDE_PROJECT_DIR",
  sessionIdEnv: "CLAUDE_SESSION_ID",
};

/** Gemini CLI platform options. */
export const GEMINI_OPTS = {
  configDir: ".gemini",
  projectDirEnv: "GEMINI_PROJECT_DIR",
  sessionIdEnv: undefined,
};

/** VS Code Copilot platform options. */
export const VSCODE_OPTS = {
  configDir: ".vscode",
  projectDirEnv: "VSCODE_CWD",
  sessionIdEnv: undefined,
};

/** Cursor platform options. */
export const CURSOR_OPTS = {
  configDir: ".cursor",
  projectDirEnv: "CURSOR_CWD",
  sessionIdEnv: "CURSOR_SESSION_ID",
};

/** Kiro CLI platform options. */
export const KIRO_OPTS = {
  configDir: ".kiro",
  projectDirEnv: undefined,   // Kiro CLI provides cwd in hook stdin, no env var
  sessionIdEnv: undefined,    // No session ID env var — uses ppid fallback
};

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
export function getSessionDBPath(opts = CLAUDE_OPTS) {
  const projectDir = getProjectDir(opts);
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  const dir = join(homedir(), opts.configDir, "context-mode", "sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}${getWorktreeSuffix()}.db`);
}

/**
 * Return the per-project session events file path.
 * Used by sessionstart hook (write) and MCP server (read + auto-index).
 * Path: ~/<configDir>/context-mode/sessions/<SHA256(projectDir)[:16]>-events.md
 */
export function getSessionEventsPath(opts = CLAUDE_OPTS) {
  const projectDir = getProjectDir(opts);
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  const dir = join(homedir(), opts.configDir, "context-mode", "sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}${getWorktreeSuffix()}-events.md`);
}

/**
 * Return the per-project cleanup flag path.
 * Used to detect true fresh starts vs --continue (which fires startup+resume).
 * Path: ~/<configDir>/context-mode/sessions/<SHA256(projectDir)[:16]>.cleanup
 */
export function getCleanupFlagPath(opts = CLAUDE_OPTS) {
  const projectDir = getProjectDir(opts);
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  const dir = join(homedir(), opts.configDir, "context-mode", "sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}${getWorktreeSuffix()}.cleanup`);
}

/**
 * Return the per-project clear-stats flag path.
 * Written by SessionStart hook on /clear, read by MCP server to reset stats.
 * Path: ~/<configDir>/context-mode/sessions/<SHA256(projectDir)[:16]>.clear-stats
 */
export function getClearStatsFlagPath(opts = CLAUDE_OPTS) {
  const projectDir = getProjectDir(opts);
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  const dir = join(homedir(), opts.configDir, "context-mode", "sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}${getWorktreeSuffix()}.clear-stats`);
}
