import { accessSync, constants, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type StorageDirectoryKind = "session" | "content" | "stats";

export type StorageOverrideEnvVar =
  | "CONTEXT_MODE_DIR"
  | "CONTEXT_MODE_SESSION_DIR"
  | "CONTEXT_MODE_CONTENT_DIR"
  | "CONTEXT_MODE_STATS_DIR";

export interface ResolvedStorageDir {
  kind: StorageDirectoryKind;
  path: string;
  envVar: StorageOverrideEnvVar | null;
  source: "default" | "override";
}

const BASE_ENV = "CONTEXT_MODE_DIR" as const;
const SPLIT_ENV = {
  session: "CONTEXT_MODE_SESSION_DIR",
  content: "CONTEXT_MODE_CONTENT_DIR",
  stats: "CONTEXT_MODE_STATS_DIR",
} as const satisfies Record<StorageDirectoryKind, Exclude<StorageOverrideEnvVar, typeof BASE_ENV>>;

export class StorageDirectoryError extends Error {
  readonly kind: StorageDirectoryKind;
  readonly path: string;
  readonly overrideEnvVar: Exclude<StorageOverrideEnvVar, typeof BASE_ENV>;

  constructor(
    kind: StorageDirectoryKind,
    path: string,
    overrideEnvVar: Exclude<StorageOverrideEnvVar, typeof BASE_ENV>,
    cause?: unknown,
  ) {
    super(errorMessage(kind, path, overrideEnvVar));
    this.name = "StorageDirectoryError";
    this.kind = kind;
    this.path = path;
    this.overrideEnvVar = overrideEnvVar;
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

function envDir(name: StorageOverrideEnvVar): string | null {
  const raw = process.env[name]?.trim();
  return raw ? resolve(raw) : null;
}

function overrideDir(kind: StorageDirectoryKind, baseSubdir: "sessions" | "content"): ResolvedStorageDir | null {
  const split = envDir(SPLIT_ENV[kind]);
  if (split) return { kind, path: split, envVar: SPLIT_ENV[kind], source: "override" };

  const base = envDir(BASE_ENV);
  if (!base) return null;
  return { kind, path: join(base, baseSubdir), envVar: BASE_ENV, source: "override" };
}

function defaultDir(kind: StorageDirectoryKind, getPath: () => string): ResolvedStorageDir {
  try {
    return { kind, path: resolve(getPath()), envVar: null, source: "default" };
  } catch (err) {
    throw new StorageDirectoryError(kind, pathFromError(err) ?? `${kind} storage directory`, SPLIT_ENV[kind], err);
  }
}

function pathFromError(err: unknown): string | null {
  return err && typeof err === "object" && typeof (err as { path?: unknown }).path === "string"
    ? (err as { path: string }).path
    : null;
}

export function resolveSessionStorageDir(getDefaultDir: () => string): ResolvedStorageDir {
  return overrideDir("session", "sessions") ?? defaultDir("session", getDefaultDir);
}

export function resolveContentStorageDir(getSessionDir: () => string): ResolvedStorageDir {
  const override = overrideDir("content", "content");
  if (override) return override;

  const session = resolveSessionStorageDir(getSessionDir);
  return {
    kind: "content",
    path: join(dirname(session.path), "content"),
    envVar: session.envVar,
    source: session.source,
  };
}

export function resolveStatsStorageDir(getSessionDir: () => string): ResolvedStorageDir {
  const override = overrideDir("stats", "sessions");
  if (override) return override;

  const session = resolveSessionStorageDir(getSessionDir);
  return {
    kind: "stats",
    path: session.path,
    envVar: session.envVar,
    source: session.source,
  };
}

export function ensureWritableStorageDir(dir: ResolvedStorageDir): string {
  try {
    mkdirSync(dir.path, { recursive: true });
    accessSync(dir.path, constants.W_OK);
    return dir.path;
  } catch (err) {
    throw new StorageDirectoryError(dir.kind, pathFromError(err) ?? dir.path, SPLIT_ENV[dir.kind], err);
  }
}

export function formatStorageDirectoryError(err: StorageDirectoryError): string {
  return errorMessage(err.kind, err.path, err.overrideEnvVar);
}

function errorMessage(
  kind: StorageDirectoryKind,
  path: string,
  overrideEnvVar: Exclude<StorageOverrideEnvVar, typeof BASE_ENV>,
): string {
  return [
    `context-mode ${kind} directory is not writable: ${path}`,
    `Set ${BASE_ENV} or ${overrideEnvVar} to a writable path.`,
  ].join("\n");
}
