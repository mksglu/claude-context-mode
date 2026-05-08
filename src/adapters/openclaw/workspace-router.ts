/**
 * Extract the agent workspace path from tool call params.
 * Looks for /openclaw/workspace-<name> patterns in cwd, file_path, and command.
 * Returns the workspace root (e.g. "/openclaw/workspace-trainer") or null.
 */
export function extractWorkspace(params: Record<string, unknown>): string | null {
  // Priority: cwd > file_path > command (most specific first)
  const sources = [
    params.cwd,
    params.file_path,
    params.command,
  ].filter((v): v is string => typeof v === "string");

  for (const src of sources) {
    const match = src.match(/\/openclaw\/workspace-[a-zA-Z0-9_-]+/);
    if (match) return match[0];
  }
  return null;
}

/**
 * Maps agent workspaces to sessionIds using sessionKey convention.
 * sessionKey pattern: "agent:<name>:main" → workspace "/openclaw/workspace-<name>"
 *
 * Why this exists alongside per-session closures:
 * Each register() call creates its own closure with its own sessionId, which
 * naturally isolates sessions. The WorkspaceRouter acts as a safety net for
 * after_tool_call events where OpenClaw may deliver the event to the wrong
 * closure (e.g. tool calls interleaving across agents). It resolves the correct
 * sessionId from workspace paths in tool params, falling back to the closure
 * sessionId when no workspace is detected.
 */
export class WorkspaceRouter {
  // workspace path → sessionId
  private map = new Map<string, string>();

  /** Register a session from session_start event. */
  registerSession(sessionKey: string, sessionId: string): void {
    const workspace = this.workspaceFromKey(sessionKey);
    if (workspace) {
      this.map.set(workspace, sessionId);
    }
  }

  /** Remove a session (e.g. on command:stop). */
  removeSession(sessionKey: string): void {
    const workspace = this.workspaceFromKey(sessionKey);
    if (workspace) {
      this.map.delete(workspace);
    }
  }

  /** Resolve sessionId from tool call params. Returns null if no match. */
  resolveSessionId(params: Record<string, unknown>): string | null {
    const workspace = extractWorkspace(params);
    if (!workspace) return null;
    return this.map.get(workspace) ?? null;
  }

  /** Derive workspace path from sessionKey. */
  private workspaceFromKey(key: string): string | null {
    // Pattern: "agent:<name>:main" or "agent:<name>:<channel>"
    const match = key.match(/^agent:([^:]+):/);
    if (!match) return null;
    return `/openclaw/workspace-${match[1]}`;
  }
}
