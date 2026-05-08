/**
 * MCP readiness sentinel — checks if MCP server has started.
 *
 * Server writes sentinel (containing its PID) after connect().
 * Hooks scan for any live sentinel to detect MCP readiness.
 *
 * Fix for #347: Claude Code spawns hooks via `bash -c "node ..."` on Linux/WSL2.
 * The intermediate shell makes process.ppid point to a transient bash PID, not
 * Claude Code. Directory-scan + PID liveness probe works regardless of spawn topology.
 *
 * Sentinel path: <tmpRoot>/context-mode-mcp-ready-<MCP_PID>
 * Scan: glob all context-mode-mcp-ready-* files, probe each PID.
 */
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SENTINEL_PREFIX = "context-mode-mcp-ready-";

/**
 * Resolve the temp root — hardcoded /tmp on Unix to avoid TMPDIR mismatch.
 * Tests may override via CONTEXT_MODE_MCP_SENTINEL_DIR to isolate scan from
 * leftover sentinels in the real /tmp.
 */
export function sentinelDir() {
  const override = process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
  if (override && override.length > 0) return override;
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

/**
 * Build sentinel path for a given PID.
 * Used by server.ts to write its own sentinel.
 */
export function sentinelPathForPid(pid) {
  return join(sentinelDir(), `${SENTINEL_PREFIX}${pid}`);
}

/**
 * @deprecated Use sentinelPathForPid(process.pid) from server.ts.
 * Kept for backward compat during migration — tests that still
 * write sentinels with process.ppid will work for one release cycle.
 */
export function sentinelPath() {
  return join(sentinelDir(), `${SENTINEL_PREFIX}${process.ppid}`);
}

/**
 * Check if any MCP server is alive by scanning sentinel files.
 *
 * Scans sentinelDir() for context-mode-mcp-ready-* files, reads the PID
 * from each, and probes with kill(pid, 0). Cleans up stale sentinels
 * from crashed servers.
 *
 * Handles:
 * - PPID mismatch (WSL2 shell wrappers) — no ppid dependency
 * - Stale sentinels (SIGKILL, OOM) — PID liveness check
 * - TMPDIR mismatch — hardcoded /tmp on Unix
 */
export function isMCPReady() {
  try {
    const dir = sentinelDir();
    const files = readdirSync(dir).filter(f => f.startsWith(SENTINEL_PREFIX));
    for (const f of files) {
      const fullPath = join(dir, f);
      try {
        const pid = parseInt(readFileSync(fullPath, "utf8"), 10);
        if (isNaN(pid)) continue;
        process.kill(pid, 0); // throws if process doesn't exist
        return true;
      } catch {
        // Dead PID or unreadable — clean up stale sentinel
        try { unlinkSync(fullPath); } catch {}
      }
    }
    return false;
  } catch {
    return false;
  }
}
