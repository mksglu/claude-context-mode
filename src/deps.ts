/**
 * deps -- Cross-project dependency resolution for ctx-deps.
 *
 * Reads .ctx-deps.json, resolves dependency paths, computes
 * ContentStore DB paths, and opens read-only ContentStores
 * for upstream projects.
 */

import { existsSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { resolve, isAbsolute, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { ContentStore } from "./store.js";
import type { DepManifest } from "./types.js";

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

export function resolveDepManifest(projectDir: string): DepManifest | null {
  const manifestPath = join(projectDir, ".ctx-deps.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.dependencies) return null;
    const deps: Record<string, { path: string }> = {};
    for (const [name, decl] of Object.entries(parsed.dependencies)) {
      if (
        decl &&
        typeof decl === "object" &&
        typeof (decl as any).path === "string" &&
        (decl as any).path.length > 0
      ) {
        deps[name] = { path: (decl as any).path };
      }
    }
    if (Object.keys(deps).length === 0) return null;
    return { dependencies: deps };
  } catch {
    return null;
  }
}

export function addDepToManifest(
  projectDir: string,
  name: string,
  depPath: string,
): { added: boolean; error?: string } {
  const manifestPath = join(projectDir, ".ctx-deps.json");
  let manifest: DepManifest;
  if (existsSync(manifestPath)) {
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf-8")); } catch { return { added: false, error: "Invalid JSON in .ctx-deps.json" }; }
  } else {
    manifest = { dependencies: {} };
  }
  if (!manifest.dependencies) manifest.dependencies = {};
  if (manifest.dependencies[name]) {
    return { added: false, error: `Dependency "${name}" already exists` };
  }
  manifest.dependencies[name] = { path: depPath };
  try {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  } catch (e: any) { return { added: false, error: e.message }; }
  return { added: true };
}

export function removeDepFromManifest(
  projectDir: string,
  name: string,
): { removed: boolean; error?: string; deletedFile?: boolean } {
  const manifestPath = join(projectDir, ".ctx-deps.json");
  if (!existsSync(manifestPath)) return { removed: false, error: "No .ctx-deps.json found" };
  let manifest: DepManifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf-8")); } catch { return { removed: false, error: "Invalid JSON in .ctx-deps.json" }; }
  if (!manifest.dependencies?.[name]) return { removed: false, error: `Dependency "${name}" not found` };
  delete manifest.dependencies[name];
  const keys = Object.keys(manifest.dependencies);
  try {
    if (keys.length === 0) {
      rmSync(manifestPath);
      return { removed: true, deletedFile: true };
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  } catch (e: any) { return { removed: false, error: e.message }; }
  return { removed: true };
}

// ---------------------------------------------------------------------------
// Path computation
// ---------------------------------------------------------------------------

function hashProjectPath(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, "/");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Compute the ContentStore DB path for a project given its
 * absolute path and config dir path (e.g. "/Users/test/.claude").
 *
 * Layout: <configDirPath>/context-mode/content/<sha256[:16]>.db
 */
export function computeDepDBPath(projectPath: string, configDirPath: string): string {
  const hash = hashProjectPath(projectPath);
  return join(configDirPath, "context-mode", "content", `${hash}.db`);
}

export function resolveDepPath(declaringProject: string, depPath: string): string {
  if (isAbsolute(depPath)) return depPath;
  return resolve(declaringProject, depPath);
}

// ---------------------------------------------------------------------------
// Store opening
// ---------------------------------------------------------------------------

/**
 * Open a read-only ContentStore for a dependency project.
 * Returns null if the DB doesn't exist at the computed path.
 *
 * Eventual consistency: read-only stores don't participate in
 * WAL checkpointing. If the upstream project is actively writing,
 * the dep store may see slightly stale data until the upstream
 * checkpoints. ctx_deps refresh re-opens the store.
 */
export function openDepStore(
  depProjectPath: string,
  configDirPath: string,
): ContentStore | null {
  const dbPath = computeDepDBPath(depProjectPath, configDirPath);
  if (!existsSync(dbPath)) return null;

  // Clean WAL/SHM before opening read-only. A write-mode DB that
  // crashed before WAL checkpoint may leave files that trigger
  // SQLITE_READONLY_CANTLOCK on read-only open. We want the last
  // committed state -- not uncommitted WAL data from another process.
  for (const suffix of ["-wal", "-shm"]) {
    try { unlinkSync(dbPath + suffix); } catch { /* may not exist */ }
  }

  try {
    return new ContentStore(dbPath, { readonly: true });
  } catch (e) {
    if (typeof process !== "undefined" && process.stderr) {
      process.stderr.write(
        `[ctx-deps] Failed to open dep store at ${dbPath}: ` +
        `${e instanceof Error ? e.message : String(e)}\n`
      );
    }
    return null;
  }
}
