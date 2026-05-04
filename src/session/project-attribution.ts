/**
 * Project attribution heuristics for session events.
 *
 * Goal: avoid pinning all activity to the startup directory when work shifts
 * across projects mid-session. This module resolves a best-effort project
 * directory per event and attaches a confidence score + source signal.
 */

import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";
import type { SessionEvent } from "../types.js";

/**
 * Confidence scores for project attribution sources.
 *
 * Higher = more reliable signal. The hierarchy reflects how directly
 * the signal indicates the user's intended project:
 * - Explicit config (workspace roots) > explicit navigation (cd) > implicit context
 * - Path-bearing events score higher than fallbacks without path signals
 */
export const ATTRIBUTION_CONFIDENCE = {
  /** Explicit workspace root from IDE/editor config */
  WORKSPACE_ROOT: 0.98,
  /** User explicitly navigated here (cd command) */
  CWD_EVENT: 0.9,
  /** Hook payload cwd — reliable but implicit */
  INPUT_CWD: 0.88,
  /** Session startup directory */
  SESSION_ORIGIN: 0.82,
  /** Carry-forward from previous high-confidence event */
  LAST_SEEN: 0.76,
  /** Inferred from file path prefix matching */
  EVENT_PATH: 0.7,
  /** Minimum confidence to carry forward as lastKnownProjectDir */
  CARRY_FORWARD_THRESHOLD: 0.55,
  /** Fallback: input_cwd without path signal */
  FALLBACK_INPUT_CWD: 0.45,
  /** Fallback: last_seen without path signal */
  FALLBACK_LAST_SEEN: 0.4,
  /** Fallback: session_origin without path signal */
  FALLBACK_SESSION_ORIGIN: 0.35,
} as const;

export type AttributionSource =
  | "event_path"
  | "cwd_event"
  | "input_cwd"
  | "workspace_root"
  | "last_seen"
  | "session_origin"
  | "env"
  | "test"
  | "unknown";

export interface ProjectAttribution {
  projectDir: string;
  source: AttributionSource;
  confidence: number; // 0..1
}

export interface AttributionContext {
  sessionOriginDir?: string | null;
  inputProjectDir?: string | null;
  workspaceRoots?: string[] | null;
  lastKnownProjectDir?: string | null;
}

interface PathSignal {
  rawPath: string;
  fromCwdEvent: boolean;
}

function normalizePath(path: string): string {
  const norm = normalize(path).replace(/\\/g, "/");
  if (norm.length <= 1) return norm;
  return norm.replace(/\/+$/, "");
}

function isPrefixPath(path: string, prefix: string): boolean {
  if (!path || !prefix) return false;
  if (path === prefix) return true;
  return path.startsWith(`${prefix}/`);
}

function normalizeRoots(roots: string[] | null | undefined): string[] {
  if (!roots || roots.length === 0) return [];
  const normalized = roots
    .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
    .map((r) => normalizePath(r));

  // dedupe + longest-first for stable best match
  const unique = Array.from(new Set(normalized));
  return unique.sort((a, b) => b.length - a.length);
}

function parseFileSearchPath(data: string): string | null {
  const marker = " in ";
  const idx = data.lastIndexOf(marker);
  if (idx < 0) return null;
  const path = data.slice(idx + marker.length).trim();
  return path.length > 0 ? path : null;
}

function looksLikePath(value: string): boolean {
  if (!value) return false;
  // Fast path-like checks: separators, dot segments, drive roots.
  return value.includes("/")
    || value.includes("\\")
    || value.startsWith(".")
    || /^[A-Za-z]:[\\/]/.test(value);
}

function extractPathSignal(event: SessionEvent): PathSignal | null {
  if (event.type === "cwd") {
    return { rawPath: event.data, fromCwdEvent: true };
  }

  if (event.type === "file_search") {
    const path = parseFileSearchPath(event.data);
    if (path) return { rawPath: path, fromCwdEvent: false };
  }

  const fileTypes = new Set([
    "file_read",
    "file_write",
    "file_edit",
    "file_glob",
    "rule",
  ]);
  if (fileTypes.has(event.type) && looksLikePath(event.data)) {
    return { rawPath: event.data, fromCwdEvent: false };
  }

  return null;
}

function absolutizePath(rawPath: string, context: AttributionContext): string | null {
  if (!rawPath) return null;

  // Ignore broad glob-only patterns that aren't useful for attribution.
  if (rawPath.includes("*") && !isAbsolute(rawPath) && !/^[A-Za-z]:[\\/]/.test(rawPath)) {
    return null;
  }

  if (isAbsolute(rawPath) || /^[A-Za-z]:[\\/]/.test(rawPath)) {
    return normalizePath(rawPath);
  }

  // For relative paths, anchor to the most recent known project first.
  const anchor = context.lastKnownProjectDir
    || context.inputProjectDir
    || context.sessionOriginDir
    || null;

  if (!anchor) return null;
  return normalizePath(resolve(anchor, rawPath));
}

function inferProjectFromAbsolutePath(
  absPath: string,
  event: SessionEvent,
  context: AttributionContext,
): ProjectAttribution {
  const normalizedRoots = normalizeRoots(context.workspaceRoots);
  const normalizedOrigin = context.sessionOriginDir ? normalizePath(context.sessionOriginDir) : "";
  const normalizedInput = context.inputProjectDir ? normalizePath(context.inputProjectDir) : "";
  const normalizedLast = context.lastKnownProjectDir ? normalizePath(context.lastKnownProjectDir) : "";

  // 1) Prefer explicit workspace roots (highest confidence).
  const workspaceRoot = normalizedRoots.find((root) => isPrefixPath(absPath, root));
  if (workspaceRoot) {
    return { projectDir: workspaceRoot, source: "workspace_root", confidence: ATTRIBUTION_CONFIDENCE.WORKSPACE_ROOT };
  }

  // 2) Prefer stable known roots from session context.
  if (normalizedInput && isPrefixPath(absPath, normalizedInput)) {
    return { projectDir: normalizedInput, source: "input_cwd", confidence: ATTRIBUTION_CONFIDENCE.INPUT_CWD };
  }
  if (normalizedOrigin && isPrefixPath(absPath, normalizedOrigin)) {
    return { projectDir: normalizedOrigin, source: "session_origin", confidence: ATTRIBUTION_CONFIDENCE.SESSION_ORIGIN };
  }
  if (normalizedLast && isPrefixPath(absPath, normalizedLast)) {
    return { projectDir: normalizedLast, source: "last_seen", confidence: ATTRIBUTION_CONFIDENCE.LAST_SEEN };
  }

  // 3) Direct cwd events indicate explicit operator intent to shift project.
  if (event.type === "cwd") {
    return { projectDir: absPath, source: "cwd_event", confidence: ATTRIBUTION_CONFIDENCE.CWD_EVENT };
  }

  // 4) Fallback for out-of-root absolute paths.
  // For known file events, use parent directory to avoid attributing to a file path.
  const fileLike = new Set(["file_read", "file_write", "file_edit", "rule"]);
  const projectDir = fileLike.has(event.type) ? normalizePath(dirname(absPath)) : absPath;
  return { projectDir, source: "event_path", confidence: ATTRIBUTION_CONFIDENCE.EVENT_PATH };
}

function fallbackAttribution(context: AttributionContext): ProjectAttribution {
  if (context.inputProjectDir) {
    return {
      projectDir: normalizePath(context.inputProjectDir),
      source: "input_cwd",
      confidence: ATTRIBUTION_CONFIDENCE.FALLBACK_INPUT_CWD,
    };
  }
  if (context.lastKnownProjectDir) {
    return {
      projectDir: normalizePath(context.lastKnownProjectDir),
      source: "last_seen",
      confidence: ATTRIBUTION_CONFIDENCE.FALLBACK_LAST_SEEN,
    };
  }
  if (context.sessionOriginDir) {
    return {
      projectDir: normalizePath(context.sessionOriginDir),
      source: "session_origin",
      confidence: ATTRIBUTION_CONFIDENCE.FALLBACK_SESSION_ORIGIN,
    };
  }
  return { projectDir: "", source: "unknown", confidence: 0 };
}

/**
 * Resolve the most likely project directory for one event.
 */
export function resolveProjectAttribution(
  event: SessionEvent,
  context: AttributionContext,
): ProjectAttribution {
  try {
    const pathSignal = extractPathSignal(event);
    if (!pathSignal) return fallbackAttribution(context);

    const absPath = absolutizePath(pathSignal.rawPath, context);
    if (!absPath) return fallbackAttribution(context);

    return inferProjectFromAbsolutePath(absPath, event, context);
  } catch {
    return fallbackAttribution(context);
  }
}

/**
 * Convenience helper: resolve attributions for a stream of events while
 * carrying forward the latest confident project as context.
 */
export function resolveProjectAttributions(
  events: SessionEvent[],
  context: AttributionContext,
): ProjectAttribution[] {
  const out: ProjectAttribution[] = [];
  let lastKnown = context.lastKnownProjectDir ? normalizePath(context.lastKnownProjectDir) : "";

  for (const ev of events) {
    const attribution = resolveProjectAttribution(ev, {
      ...context,
      lastKnownProjectDir: lastKnown || context.lastKnownProjectDir || null,
    });
    out.push(attribution);

    if (attribution.projectDir && attribution.confidence >= ATTRIBUTION_CONFIDENCE.CARRY_FORWARD_THRESHOLD) {
      lastKnown = attribution.projectDir;
    }
  }

  return out;
}

/**
 * 0..100 score for UI display.
 */
export function confidenceToPercent(confidence: number): number {
  const clamped = Math.max(0, Math.min(1, confidence));
  return Math.round(clamped * 100);
}

/**
 * True when attribution is strong enough for project-level spending claims.
 */
export function isHighConfidenceAttribution(confidence: number): boolean {
  return confidence >= 0.8;
}

/**
 * Lightweight utility used by some hooks to normalize path separators
 * before writing attribution metadata.
 */
export function normalizeProjectDir(projectDir: string): string {
  return normalizePath(projectDir);
}

export const PROJECT_ATTRIBUTION_VERSION = 1;

// Keep explicit references to path separator for bundlers that tree-shake too aggressively.
void sep;
