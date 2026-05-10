import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Project-dir resolution helpers — shared between `start.mjs` (the MCP entry
 * point) and `src/server.ts getProjectDir()` (the consumer).
 *
 * Background: when Claude Code runs `/ctx-upgrade`, it kills + respawns the
 * MCP server. The respawn happens with `cwd` set to the plugin install
 * directory (`~/.claude/plugins/cache/context-mode/context-mode/<version>/`).
 * The legacy `start.mjs` then set `CLAUDE_PROJECT_DIR = originalCwd`, which
 * poisoned every downstream `ctx_stats` / SessionDB / hash computation —
 * sessions silently re-rooted under the plugin install path.
 *
 * Defense-in-depth fix (v1.0.113):
 *   - `start.mjs` calls `isPluginInstallPath(originalCwd)` and skips the env
 *     auto-set when true (no poisoning at the source).
 *   - `getProjectDir()` calls `resolveProjectDir(...)` which rejects plugin-
 *     pathed env vars and the plugin cwd, preferring `process.env.PWD`
 *     (shell-set, survives `process.chdir`) before falling back.
 */

/**
 * Detect whether a path lives inside the Claude Code plugin install tree —
 * specifically `<home>/.claude/plugins/cache/<plugin>/<plugin>/<version>/`
 * or the marketplace mirror `<home>/.claude/plugins/marketplaces/...`.
 *
 * Cross-OS: matches both POSIX (`/`) and Windows (`\`) path separators.
 * Independent of `home` location — we only care about the `.claude/plugins/`
 * suffix pattern.
 */
export function isPluginInstallPath(p: string): boolean {
  if (!p) return false;
  return /[/\\]\.claude[/\\]plugins[/\\](cache|marketplaces)[/\\]/.test(p);
}

/**
 * Read the per-session project dir from Claude Code's transcript files.
 *
 * Claude Code writes session transcripts under
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Each line is a JSON
 * event; an early line (typically line 2) carries a `cwd` field with the
 * literal project directory the session is running against. The encoded dir
 * name itself is lossy (`/` and `.` both become `-`), so we read the JSONL.
 *
 * This is the strongest available signal when Claude Code does NOT propagate
 * `CLAUDE_PROJECT_DIR` to the spawned MCP env (the common case when Claude
 * Code is launched from the desktop app rather than `cd <project> && claude`).
 *
 * Returns `undefined` when no transcript exists, the projects dir is empty,
 * or no transcript carries a `cwd` field — caller falls through.
 *
 * Multi-window safety: the most-recently-modified jsonl wins. When the user
 * actively talks to one Claude Code window, that window's transcript is the
 * one being written to RIGHT NOW, so its mtime is freshest. Other windows'
 * transcripts have older mtimes and are correctly ignored.
 */
export function resolveProjectDirFromTranscript(opts: {
  projectsRoot: string;
}): string | undefined {
  if (!fs.existsSync(opts.projectsRoot)) return undefined;

  let bestPath: string | undefined;
  let bestMtime = 0;
  try {
    for (const dir of fs.readdirSync(opts.projectsRoot)) {
      const dirPath = path.join(opts.projectsRoot, dir);
      let stat;
      try { stat = fs.statSync(dirPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let files;
      try { files = fs.readdirSync(dirPath); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = path.join(dirPath, f);
        try {
          const m = fs.statSync(fp).mtimeMs;
          if (m > bestMtime) { bestMtime = m; bestPath = fp; }
        } catch { /* skip */ }
      }
    }
  } catch { return undefined; }

  if (!bestPath) return undefined;

  // Read first ~10 lines until we find a cwd field. The jsonl is
  // append-only and can be huge (60+ MB on long sessions) — never load it
  // into memory; stream a small head buffer.
  try {
    const fd = fs.openSync(bestPath, "r");
    try {
      const buf = Buffer.alloc(8192);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytes).toString("utf-8");
      for (const line of text.split("\n").slice(0, 10)) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as { cwd?: unknown };
          if (typeof obj.cwd === "string" && obj.cwd.length > 0) return obj.cwd;
        } catch { /* skip malformed line */ }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* file vanished mid-read */ }

  return undefined;
}

/**
 * Pure project-dir resolver. Mirror of the env-var chain inside
 * `src/server.ts getProjectDir()`, but takes its inputs explicitly so the
 * resolver can be exercised under test without process-level mutation.
 *
 * Resolution order:
 *   1. Adapter-priority env vars (CLAUDE / GEMINI / VSCODE / OPENCODE / PI /
 *      IDEA / CONTEXT_MODE) — first non-empty AND non-plugin-path wins.
 *   2. Claude Code transcript heuristic — read `cwd` from the most-recently-
 *      modified `~/.claude/projects/<encoded>/<session>.jsonl`. This is the
 *      most reliable signal when Claude Code launched MCP from a non-project
 *      cwd (desktop-app launch, `/ctx-upgrade` respawn, etc.).
 *   3. `process.env.PWD` — shell-set, NOT updated by `process.chdir()`, so
 *      it survives the `start.mjs` chdir into the plugin dir. Skipped if
 *      it too points at a plugin install path.
 *   4. `cwd` — last resort. Returned even if it is a plugin path; the
 *      caller is responsible for rendering a graceful "no project context"
 *      message rather than panicking. Keeping the function total preserves
 *      operation of project-independent tools (sandbox execute, fetch).
 */
export function resolveProjectDir(opts: {
  env: Record<string, string | undefined>;
  cwd: string;
  pwd: string | undefined;
  /** Optional override; production code passes `~/.claude/projects`. */
  transcriptsRoot?: string;
}): string {
  const { env, cwd, pwd, transcriptsRoot } = opts;
  const candidates = [
    env.CLAUDE_PROJECT_DIR,
    env.GEMINI_PROJECT_DIR,
    env.VSCODE_CWD,
    env.OPENCODE_PROJECT_DIR,
    env.PI_PROJECT_DIR,
    env.IDEA_INITIAL_DIRECTORY,
    env.CONTEXT_MODE_PROJECT_DIR,
  ];
  for (const c of candidates) {
    if (c && !isPluginInstallPath(c)) return c;
  }
  if (transcriptsRoot) {
    const fromTranscript = resolveProjectDirFromTranscript({ projectsRoot: transcriptsRoot });
    if (fromTranscript && !isPluginInstallPath(fromTranscript)) return fromTranscript;
  }
  if (pwd && !isPluginInstallPath(pwd)) return pwd;
  return cwd;
}
