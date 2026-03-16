/**
 * Shared type definitions for context-mode pi extension.
 */

// ─────────────────────────────────────────────────────────
// Session event types
// ─────────────────────────────────────────────────────────

/** Tool call representation used during event extraction. */
export interface ToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse?: string;
  isError?: boolean;
}

/** User message representation used during event extraction. */
export interface UserMessage {
  content: string;
  timestamp?: string;
}

/**
 * Session event as stored in SessionDB.
 * Each event captures a discrete unit of session activity.
 */
export interface SessionEvent {
  type: string;
  category: string;
  data: string;
  priority: number;
  data_hash: string;
}

// ─────────────────────────────────────────────────────────
// Execution result
// ─────────────────────────────────────────────────────────

/**
 * Result returned after running a code snippet.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  backgrounded?: boolean;
}

// ─────────────────────────────────────────────────────────
// Resume snapshot
// ─────────────────────────────────────────────────────────

/**
 * Structured representation of a session resume snapshot.
 */
export interface ResumeSnapshot {
  generatedAt: string;
  summary: string;
  events: SessionEvent[];
}

// ─────────────────────────────────────────────────────────
// Priority constants
// ─────────────────────────────────────────────────────────

export const EventPriority = {
  LOW: 1,
  NORMAL: 2,
  HIGH: 3,
  CRITICAL: 4,
} as const;

export type EventPriorityLevel = (typeof EventPriority)[keyof typeof EventPriority];
