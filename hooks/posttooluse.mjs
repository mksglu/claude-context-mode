#!/usr/bin/env node
/**
 * PostToolUse hook for context-mode session continuity.
 *
 * Captures session events from tool calls (13 categories) and stores
 * them in the per-project SessionDB for later resume snapshot building.
 *
 * Must be fast (<20ms). No network, no LLM, just SQLite writes.
 *
 * Crash-resilience: wrapped via runHook (#414).
 */

import { runHook } from "./run-hook.mjs";

await runHook(async () => {
  const {
    readStdin,
    parseStdin,
    getSessionId,
    getSessionDBPath,
    getInputProjectDir,
  } = await import("./session-helpers.mjs");
  const { createSessionLoaders, attributeAndInsertEvents } = await import("./session-loaders.mjs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { readFileSync, unlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  // Resolve absolute path for imports — relative dynamic imports can fail
  // when Claude Code invokes hooks from a different working directory.
  const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
  const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);

  try {
    const raw = await readStdin();
    const input = parseStdin(raw);
    const projectDir = getInputProjectDir(input);

    const { extractEvents } = await loadExtract();
    const { resolveProjectAttributions } = await loadProjectAttribution();
    const { SessionDB } = await loadSessionDB();

    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input);

    // Ensure session meta exists
    db.ensureSession(sessionId, projectDir);

    // Extract and store events
    const events = extractEvents({
      tool_name: input.tool_name,
      tool_input: input.tool_input ?? {},
      tool_response: typeof input.tool_response === "string"
        ? input.tool_response
        : JSON.stringify(input.tool_response ?? ""),
      tool_output: input.tool_output,
    });

    attributeAndInsertEvents(db, sessionId, events, input, projectDir, "PostToolUse", resolveProjectAttributions);

    // ─── Category 18: Rejected-approach — read PreToolUse marker ───
    try {
      const rejectedPath = resolve(tmpdir(), `context-mode-rejected-${sessionId}.txt`);
      let rejectedData;
      try {
        rejectedData = readFileSync(rejectedPath, "utf-8").trim();
        unlinkSync(rejectedPath);
      } catch { /* no marker */ }
      if (rejectedData) {
        const colonIdx = rejectedData.indexOf(":");
        const rejTool = colonIdx > 0 ? rejectedData.slice(0, colonIdx) : rejectedData;
        const rejReason = colonIdx > 0 ? rejectedData.slice(colonIdx + 1) : "denied";
        db.insertEvent(sessionId, {
          type: "rejected",
          category: "rejected-approach",
          data: `${rejTool}: ${rejReason}`,
          priority: 2,
        }, "PreToolUse");
      }
    } catch { /* best-effort */ }

    // ─── Category 27: Latency — read cross-hook marker and emit event if slow ───
    try {
      const toolName = input.tool_name ?? "";
      if (toolName) {
        const markerPath = resolve(tmpdir(), `context-mode-latency-${sessionId}-${toolName}.txt`);
        let startTime;
        try {
          startTime = parseInt(readFileSync(markerPath, "utf-8").trim(), 10);
          unlinkSync(markerPath);
        } catch {
          // No marker — pretooluse didn't write one or already consumed
        }
        if (startTime && !isNaN(startTime)) {
          const duration = Date.now() - startTime;
          if (duration > 5000) {
            db.insertEvent(sessionId, {
              type: "tool_latency",
              category: "latency",
              data: `${toolName}: ${duration}ms`,
              priority: 3,
            }, "PostToolUse");
          }
        }
      }
    } catch { /* latency tracking is best-effort */ }

    db.close();
  } catch {
    // PostToolUse must never block the session — silent fallback
  }

  // PostToolUse hooks don't need hookSpecificOutput
});
