/**
 * session-stats — Per-session context consumption tracking.
 *
 * Tracks call counts and byte metrics for each tool, plus total bytes
 * indexed (FTS5) and sandboxed (network I/O inside subprocess).
 */

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export interface SessionStats {
  calls: Record<string, number>;
  bytesReturned: Record<string, number>;
  bytesIndexed: number;
  bytesSandboxed: number;
  sessionStart: number;
}

/**
 * Create a fresh SessionStats instance.
 */
export function createSessionStats(): SessionStats {
  return {
    calls: {},
    bytesReturned: {},
    bytesIndexed: 0,
    bytesSandboxed: 0,
    sessionStart: Date.now(),
  };
}

/**
 * Track a tool response: record call count and byte size, then return
 * the response unchanged.
 */
export function trackResponse(
  stats: SessionStats,
  toolName: string,
  response: ToolResult,
): ToolResult {
  const bytes = response.content.reduce(
    (sum, c) => sum + Buffer.byteLength(c.text),
    0,
  );
  stats.calls[toolName] = (stats.calls[toolName] || 0) + 1;
  stats.bytesReturned[toolName] =
    (stats.bytesReturned[toolName] || 0) + bytes;
  return response;
}

/**
 * Track bytes that were indexed into FTS5 (kept out of context).
 */
export function trackIndexed(stats: SessionStats, bytes: number): void {
  stats.bytesIndexed += bytes;
}
