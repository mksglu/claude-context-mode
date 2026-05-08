#!/usr/bin/env node
/**
 * SessionStart hook for context-mode
 *
 * Provides the agent with XML-structured "Rules of Engagement"
 * at the beginning of each session. Injects session knowledge on
 * both startup and compact to maintain continuity.
 *
 * Session Lifecycle Rules:
 * - "startup"  → Fresh session. Inject previous session knowledge. Cleanup old data.
 * - "compact"  → Auto-compact triggered. Inject resume snapshot + stats.
 * - "resume"   → User invoked --continue, --resume, or /resume. CC sends the
 *                ACTIVE session_id; for /resume this is typically a *fresh*
 *                id, so live events miss → fall back to snapshot (#413).
 * - "clear"    → User cleared context. No resume.
 *
 * Crash-resilience: wrapped via runHook (#414) — all module loads happen
 * dynamically inside the wrapper so a missing/poisoned dep can never hard-fail
 * the hook. Errors land in ~/.claude/context-mode/hook-errors.log.
 */

import { runHook } from "./run-hook.mjs";

await runHook(async () => {
  const { createRoutingBlock } = await import("./routing-block.mjs");
  const { createToolNamer } = await import("./core/tool-naming.mjs");
  const { detectPlatformFromEnv } = await import("./core/platform-detect.mjs");
  const { buildAutoInjection } = await import("./auto-injection.mjs");
  const {
    readStdin,
    parseStdin,
    getSessionId,
    getSessionDBPath,
    getSessionEventsPath,
    getCleanupFlagPath,
    resolveConfigDir,
  } = await import("./session-helpers.mjs");
  const { writeSessionEventsFile, buildSessionDirective, getSessionEvents } = await import(
    "./session-directive.mjs"
  );
  const { createSessionLoaders } = await import("./session-loaders.mjs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { readFileSync, unlinkSync, readdirSync, rmSync, statSync } = await import("node:fs");

  const detectedPlatform = detectPlatformFromEnv();
  const toolNamer = createToolNamer(detectedPlatform);
  const ROUTING_BLOCK = createRoutingBlock(toolNamer);

  // Resolve absolute path for imports (fileURLToPath for Windows compat)
  const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
  const { loadSessionDB } = createSessionLoaders(HOOK_DIR);

  let additionalContext = ROUTING_BLOCK;

  try {
    const raw = await readStdin();
    const input = parseStdin(raw);
    const source = input.source ?? "startup";

    if (source === "compact") {
      // Session was compacted — write events to file for auto-indexing, inject directive only
      const { SessionDB } = await loadSessionDB();
      const dbPath = getSessionDBPath();
      const db = new SessionDB({ dbPath });
      const sessionId = getSessionId(input);
      const resume = db.getResume(sessionId);

      if (resume && !resume.consumed) {
        db.markResumeConsumed(sessionId);
      }

      const events = getSessionEvents(db, sessionId);
      if (events.length > 0) {
        const eventMeta = writeSessionEventsFile(events, getSessionEventsPath());
        additionalContext += buildSessionDirective("compact", eventMeta, toolNamer);

        // Auto-inject behavioral state on compaction (role, decisions, skills, intent)
        const autoInjection = buildAutoInjection(events);
        if (autoInjection) {
          additionalContext += "\n\n" + autoInjection;
        }

        // Write session-resume event
        try {
          db.insertEvent(
            sessionId,
            {
              type: "resume_completed",
              category: "session-resume",
              data: `Session resumed from ${source}. Prior events loaded.`,
              priority: 1,
            },
            "SessionStart",
          );
        } catch { /* best-effort */ }
      }

      db.close();
    } else if (source === "resume") {
      // User invoked --continue, --resume, or /resume — clear cleanup flag so
      // startup doesn't wipe data on the next fresh boot.
      try { unlinkSync(getCleanupFlagPath()); } catch { /* no flag */ }

      const { SessionDB } = await loadSessionDB();
      const dbPath = getSessionDBPath();
      const db = new SessionDB({ dbPath });

      // 1) Try live events for the resumed session. Filter strictly to the
      //    incoming session_id — falling back to getLatestSessionEvents(db)
      //    leaks events from any other session whose session_meta.started_at
      //    is more recent (cross-worktree bleed observed in the wild).
      const sessionId = getSessionId(input);
      const events = sessionId ? getSessionEvents(db, sessionId) : [];
      if (events.length > 0) {
        const eventMeta = writeSessionEventsFile(events, getSessionEventsPath());
        additionalContext += buildSessionDirective("resume", eventMeta, toolNamer);
      } else if (sessionId) {
        // 2) Snapshot fallback (#413). /resume hands us a *new* active session
        //    id whose live event table is empty; the prior conversation lives
        //    in `session_resume.snapshot`. Mirrors the OpenCode/OpenClaw resume
        //    injection path (opencode-plugin.ts:454). claimLatestUnconsumedResume
        //    excludes the current id, so we surface the latest unconsumed
        //    snapshot from any prior session in this project.
        const row = db.claimLatestUnconsumedResume(sessionId);
        if (row?.snapshot) {
          additionalContext += "\n\n" + row.snapshot;
        }
      }

      db.close();
    } else if (source === "startup") {
      // Fresh session (no --continue) — clean slate, capture CLAUDE.md rules.
      const { SessionDB } = await loadSessionDB();
      const dbPath = getSessionDBPath();
      const db = new SessionDB({ dbPath });
      try { unlinkSync(getSessionEventsPath()); } catch { /* no stale file */ }

      // Detect true fresh start vs --continue (which fires startup→resume).
      // If cleanup flag exists from a PREVIOUS startup that was never followed by
      // resume, that was a true fresh start — aggressively wipe all data.
      db.cleanupOldSessions(7);
      db.db.exec(`DELETE FROM session_events WHERE session_id NOT IN (SELECT session_id FROM session_meta)`);

      // Proactively capture CLAUDE.md files — Claude Code loads them as system
      // context at startup, invisible to PostToolUse hooks. We read them from
      // disk so they survive compact/resume via the session events pipeline.
      const sessionId = getSessionId(input);
      const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
      db.ensureSession(sessionId, projectDir);
      const claudeMdPaths = [
        join(resolveConfigDir(), "CLAUDE.md"),
        join(projectDir, "CLAUDE.md"),
        join(projectDir, ".claude", "CLAUDE.md"),
      ];
      for (const p of claudeMdPaths) {
        try {
          const content = readFileSync(p, "utf-8");
          if (content.trim()) {
            db.insertEvent(sessionId, { type: "rule", category: "rule", data: p, priority: 1 });
            db.insertEvent(sessionId, { type: "rule_content", category: "rule", data: content, priority: 1 });
          }
        } catch { /* file doesn't exist — skip */ }
      }

      db.close();

      // Age-gated lazy cleanup of old plugin cache version dirs (#181).
      // Only delete dirs older than 1 hour to avoid breaking active sessions.
      try {
        const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
        if (pluginRoot) {
          const cacheParentMatch = pluginRoot.match(/^(.*[\\/]plugins[\\/]cache[\\/][^\\/]+[\\/][^\\/]+[\\/])/);
          if (cacheParentMatch) {
            const cacheParent = cacheParentMatch[1];
            const myDir = pluginRoot.replace(cacheParent, "").replace(/[\\/]/g, "");
            const ONE_HOUR = 3600000;
            const now = Date.now();
            for (const d of readdirSync(cacheParent)) {
              if (d === myDir) continue;
              try {
                const st = statSync(join(cacheParent, d));
                if (now - st.mtimeMs > ONE_HOUR) {
                  rmSync(join(cacheParent, d), { recursive: true, force: true });
                }
              } catch { /* skip */ }
            }
          }
        }
      } catch { /* best effort — never block session start */ }
    }
    // "clear" — no reset needed; ctx_purge is the only wipe mechanism
  } catch (err) {
    // Session continuity is best-effort — never block session start
    try {
      const { appendFileSync } = await import("node:fs");
      const { join: pjoin } = await import("node:path");
      const { resolveConfigDir: _resolve } = await import("./session-helpers.mjs");
      appendFileSync(
        pjoin(_resolve(), "context-mode", "sessionstart-debug.log"),
        `[${new Date().toISOString()}] ${err?.message || err}\n${err?.stack || ""}\n`,
      );
    } catch { /* ignore logging failure */ }
  }

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  }));
});
