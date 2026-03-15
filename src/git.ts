import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * Returns the worktree suffix to append to session identifiers.
 * Returns empty string when running in the main working tree.
 *
 * Set CONTEXT_MODE_SESSION_SUFFIX to an explicit value to override
 * (useful in CI environments or when git is unavailable).
 * Set to empty string to disable isolation entirely.
 */
export function getWorktreeSuffix(): string {
  // Env var override — takes priority over git detection
  const envSuffix = process.env.CONTEXT_MODE_SESSION_SUFFIX;
  if (envSuffix !== undefined) {
    return envSuffix ? `__${envSuffix}` : "";
  }

  try {
    const cwd = process.cwd();
    // The main worktree path from `git worktree list` first entry
    const mainWorktree = execFileSync(
      "git",
      ["worktree", "list", "--porcelain"],
      {
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .split(/\r?\n/)
      .find((l) => l.startsWith("worktree "))
      ?.replace("worktree ", "")
      ?.trim();

    if (mainWorktree && cwd !== mainWorktree) {
      // Hash the full path to avoid collisions between same-named worktrees
      const suffix = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
      return `__${suffix}`;
    }
  } catch {
    // git not available or not a git repo — no suffix
  }

  return "";
}
