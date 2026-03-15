import { execSync } from "node:child_process";
import { basename } from "node:path";

/**
 * Returns the worktree suffix to append to session identifiers.
 * Returns empty string when running in the main working tree.
 *
 * Supports CONTEXT_MODE_SESSION_SUFFIX env var for explicit override
 * (useful when git is unavailable or in CI environments).
 */
export function getWorktreeSuffix(): string {
  // Explicit env var override (CONTEXT-VIR-001 P2.2 fallback)
  const envSuffix = process.env.CONTEXT_MODE_SESSION_SUFFIX;
  if (envSuffix !== undefined) {
    return envSuffix ? `__${envSuffix}` : "";
  }

  try {
    const cwd = process.cwd();
    // The main worktree path from `git worktree list` first entry
    const mainWorktree = execSync("git worktree list --porcelain", {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("
")
      .find((l) => l.startsWith("worktree "))
      ?.replace("worktree ", "")
      ?.trim();

    if (mainWorktree && cwd !== mainWorktree) {
      return `__${basename(cwd)}`;
    }
  } catch {
    // git not available or not a git repo — no suffix
  }

  return "";
}
