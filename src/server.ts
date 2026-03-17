#!/usr/bin/env node
/**
 * context-mode MCP server — Main entry point.
 *
 * Initializes the MCP server, executor, content store, and registers all tools.
 * Extracted tool modules are imported from src/tools/ for maintainability.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// Core dependencies
import { PolyglotExecutor } from "./executor.js";
import { ContentStore, cleanupStaleDBs } from "./store.js";
import { detectRuntimes, getRuntimeSummary, getAvailableLanguages, hasBunRuntime } from "./runtime.js";
import { startLifecycleGuard } from "./lifecycle.js";

// Session stats and tracking
import { createSessionStats, trackResponse, trackIndexed, type SessionStats, type ToolResult } from "./server/session-stats.js";

// Tool modules
import { registerDoctorTool } from "./tools/doctor.js";
import { registerUpgradeTool } from "./tools/upgrade.js";
import { registerStatsTool } from "./tools/stats.js";
import { registerIndexTool } from "./tools/ctx-index.js";
import { registerSearchTool } from "./tools/search.js";
import { registerFetchAndIndexTool } from "./tools/fetch-and-index.js";
import { registerExecuteTool } from "./tools/execute.js";
import { registerExecuteFileTool } from "./tools/execute-file.js";
import { registerBatchExecuteTool } from "./tools/batch-execute.js";

// Version detection
const __pkg_dir = dirname(fileURLToPath(import.meta.url));
const VERSION: string = (() => {
  for (const rel of ["../package.json", "./package.json"]) {
    const p = resolve(__pkg_dir, rel);
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")).version; } catch {}
    }
  }
  return "unknown";
})();

// Prevent silent server death from unhandled async errors
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[context-mode] unhandledRejection: ${err}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`[context-mode] uncaughtException: ${err?.message ?? err}\n`);
});

// Runtime detection
const runtimes = detectRuntimes();
const available = getAvailableLanguages(runtimes);

// MCP server instance
const server = new McpServer({
  name: "context-mode",
  version: VERSION,
});

// Polyglot executor for sandboxed code execution
const executor = new PolyglotExecutor({
  runtimes,
  projectRoot: process.env.CLAUDE_PROJECT_DIR,
});

// Lazy singleton — no DB overhead unless index/search is used
let _store: ContentStore | null = null;
const sessionStats = createSessionStats();

/**
 * Auto-index session events files written by SessionStart hook.
 * Scans ~/.claude/context-mode/sessions/ for *-events.md files.
 * Files are consumed (deleted) after indexing to prevent double-indexing.
 */
function maybeIndexSessionEvents(store: ContentStore): void {
  try {
    const sessionsDir = join(homedir(), ".claude", "context-mode", "sessions");
    if (!existsSync(sessionsDir)) return;
    const files = readdirSync(sessionsDir).filter(f => f.endsWith("-events.md"));
    for (const file of files) {
      const filePath = join(sessionsDir, file);
      try {
        store.index({ path: filePath, source: "session-events" });
        unlinkSync(filePath);
      } catch { /* best-effort per file */ }
    }
  } catch { /* best-effort — session continuity never blocks tools */ }
}

/**
 * Get or create the ContentStore singleton.
 * Auto-indexes session events on first access.
 */
function getStore(): ContentStore {
  if (!_store) _store = new ContentStore();
  maybeIndexSessionEvents(_store);
  return _store;
}

/**
 * Track response metrics: call count and byte size.
 * Returns the response unchanged after recording stats.
 */
function trackResponseWrapper(toolName: string, response: ToolResult): ToolResult {
  return trackResponse(sessionStats, toolName, response);
}

/**
 * Track bytes that were indexed into FTS5 (kept out of context).
 */
function trackIndexedWrapper(bytes: number): void {
  trackIndexed(sessionStats, bytes);
}

// ─────────────────────────────────────────────────────────
// Tool registration — all tools imported from src/tools/
// ─────────────────────────────────────────────────────────

const commonDeps = {
  trackResponse: trackResponseWrapper,
  trackIndexed: trackIndexedWrapper,
  getStore,
  executor,
  sessionStats,
};

// Simple meta-tools (no executor/store deps)
registerDoctorTool(server, { trackResponse: trackResponseWrapper });
registerUpgradeTool(server, { trackResponse: trackResponseWrapper });

// Stats tool (needs sessionStats)
registerStatsTool(server, { trackResponse: trackResponseWrapper, sessionStats });

// Index tool
registerIndexTool(server, {
  trackResponse: trackResponseWrapper,
  trackIndexed: trackIndexedWrapper,
  getStore,
});

// Search tool
registerSearchTool(server, {
  trackResponse: trackResponseWrapper,
  getStore,
});

// Fetch & Index tool
registerFetchAndIndexTool(server, {
  trackResponse: trackResponseWrapper,
  trackIndexed: trackIndexedWrapper,
  getStore,
  executor,
});

// Execute tool
registerExecuteTool(server, commonDeps);

// Execute File tool
registerExecuteFileTool(server, commonDeps);

// Batch Execute tool
registerBatchExecuteTool(server, commonDeps);

// ─────────────────────────────────────────────────────────
// Server startup
// ─────────────────────────────────────────────────────────

async function main() {
  // Clean up stale DB files from previous sessions
  const cleaned = cleanupStaleDBs();
  if (cleaned > 0) {
    console.error(`Cleaned up ${cleaned} stale DB file(s) from previous sessions`);
  }

  // Clean up own DB + backgrounded processes on shutdown
  const shutdown = () => {
    executor.cleanupBackgrounded();
    if (_store) _store.cleanup();
  };
  const gracefulShutdown = async () => {
    shutdown();
    process.exit(0);
  };
  process.on("exit", shutdown);
  process.on("SIGINT", () => { gracefulShutdown(); });
  process.on("SIGTERM", () => { gracefulShutdown(); });

  // Lifecycle guard: detect parent death + stdin close to prevent orphaned processes (#103)
  startLifecycleGuard({ onShutdown: () => gracefulShutdown() });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Write routing instructions for hookless platforms (e.g. Codex CLI, Antigravity)
  try {
    const { detectPlatform, getAdapter } = await import("./adapters/detect.js");
    const clientInfo = server.server.getClientVersion();
    const signal = detectPlatform(clientInfo ?? undefined);
    const adapter = await getAdapter(signal.platform);
    if (clientInfo) {
      console.error(`MCP client: ${clientInfo.name} v${clientInfo.version} → ${signal.platform}`);
    }
    if (!adapter.capabilities.sessionStart) {
      const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.env.CODEX_HOME ?? process.cwd();
      const written = adapter.writeRoutingInstructions(projectDir, pluginRoot);
      if (written) console.error(`Wrote routing instructions: ${written}`);
    }
  } catch { /* best effort — don't block server startup */ }

  console.error(`Context Mode MCP server v${VERSION} running on stdio`);
  console.error(`Detected runtimes:\n${getRuntimeSummary(runtimes)}`);
  if (!hasBunRuntime()) {
    console.error(
      "\nPerformance tip: Install Bun for 3-5x faster JS/TS execution",
    );
    console.error("  curl -fsSL https://bun.sh/install | bash");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

// ─────────────────────────────────────────────────────────
// Re-exports for backward compatibility
// ─────────────────────────────────────────────────────────

export { positionsFromHighlight, extractSnippet } from "./server/snippet-extractor.js";
