#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync, readdirSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { z } from "zod";
import { PolyglotExecutor } from "./executor.js";
import { ContentStore, cleanupStaleDBs, cleanupStaleContentDBs, type SearchResult, type IndexResult } from "./store.js";
import {
  readBashPolicies,
  evaluateCommandDenyOnly,
  extractShellCommands,
  readToolDenyPatterns,
  evaluateFilePath,
} from "./security.js";
import {
  detectRuntimes,
  getRuntimeSummary,
  getAvailableLanguages,
  hasBunRuntime,
} from "./runtime.js";
import { classifyNonZeroExit } from "./exit-classify.js";
import { startLifecycleGuard } from "./lifecycle.js";
import { getWorktreeSuffix } from "./session/db.js";
import { loadDatabase } from "./db-base.js";
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

const runtimes = detectRuntimes();
const available = getAvailableLanguages(runtimes);
const server = new McpServer({
  name: "context-mode",
  version: VERSION,
});

// Register empty prompts/resources handlers so MCP clients don't get -32601 (#168).
// OpenCode calls listPrompts()/listResources() unconditionally — the error can poison
// the SDK transport layer, causing subsequent listTools() calls to fail permanently.
import { ListPromptsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema } from "@modelcontextprotocol/sdk/types.js";
server.server.registerCapabilities({ prompts: { listChanged: false }, resources: { listChanged: false } });
server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

const executor = new PolyglotExecutor({
  runtimes,
  projectRoot: process.env.CLAUDE_PROJECT_DIR,
});

// Lazy singleton — no DB overhead unless index/search is used
let _store: ContentStore | null = null;

/**
 * Auto-index session events files written by SessionStart hook.
 * Scans ~/.claude/context-mode/sessions/ for *-events.md files.
 * CLAUDE_PROJECT_DIR is NOT available to MCP servers — only to hooks —
 * so we glob-scan instead of computing a specific hash.
 * Files are consumed (deleted) after indexing to prevent double-indexing.
 * Called on every getStore() — readdirSync is sub-millisecond when no files match.
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
 * Compute a per-project persistent path for the ContentStore.
 * Uses SHA256 of the project dir (normalized for Windows) to avoid collisions.
 */
function getStorePath(): string {
  const projectDir = process.env.CLAUDE_PROJECT_DIR
    || process.env.GEMINI_PROJECT_DIR
    || process.env.OPENCLAW_HOME
    || process.cwd();
  const normalized = projectDir.replace(/\\/g, "/");
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  const dir = join(homedir(), ".context-mode", "content");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}.db`);
}

function getStore(): ContentStore {
  if (!_store) {
    // Content DB cleanup on fresh start is handled by SessionStart hook.
    // Server just opens whatever DB exists (or creates new if hook deleted it).
    const dbPath = getStorePath();
    _store = new ContentStore(dbPath);

    // One-time startup cleanup: remove stale content DBs (>14 days)
    try {
      const contentDir = join(homedir(), ".context-mode", "content");
      cleanupStaleContentDBs(contentDir, 14);
      _store.cleanupStaleSources(14);
    } catch { /* best-effort */ }

    // Also clean old PID-based DBs from migration
    cleanupStaleDBs();
  }
  maybeIndexSessionEvents(_store);
  return _store;
}

// ─────────────────────────────────────────────────────────
// Session stats — track context consumption per tool
// ─────────────────────────────────────────────────────────

const sessionStats = {
  calls: {} as Record<string, number>,
  bytesReturned: {} as Record<string, number>,
  bytesIndexed: 0,
  bytesSandboxed: 0, // network I/O consumed inside sandbox (never enters context)
  cacheHits: 0,
  cacheBytesSaved: 0, // bytes avoided by TTL cache hits
  sessionStart: Date.now(),
};

/**
 * Reset session stats to zero. Called when /clear flag is detected.
 * The SessionStart hook writes a .clear-stats flag file on /clear,
 * and the server checks for it before each tool call.
 */
function resetSessionStats(): void {
  sessionStats.calls = {};
  sessionStats.bytesReturned = {};
  sessionStats.bytesIndexed = 0;
  sessionStats.bytesSandboxed = 0;
  sessionStats.cacheHits = 0;
  sessionStats.cacheBytesSaved = 0;
  sessionStats.sessionStart = Date.now();

  // Also reset FTS5 content store — drop and recreate on next getStore() call
  if (_store) {
    try { _store.cleanup(); } catch { /* best effort */ }
    _store = null;
  }
}

/** Check for .clear-stats flag and reset stats if found. */
function checkClearStatsFlag(): void {
  const sessDir = join(homedir(), ".claude", "context-mode", "sessions");
  try {
    const flags = readdirSync(sessDir).filter((f) => f.endsWith(".clear-stats"));
    for (const f of flags) {
      unlinkSync(join(sessDir, f));
    }
    if (flags.length > 0) resetSessionStats();
  } catch { /* best effort */ }
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function trackResponse(toolName: string, response: ToolResult): ToolResult {
  checkClearStatsFlag();
  const bytes = response.content.reduce(
    (sum, c) => sum + Buffer.byteLength(c.text),
    0,
  );
  sessionStats.calls[toolName] = (sessionStats.calls[toolName] || 0) + 1;
  sessionStats.bytesReturned[toolName] =
    (sessionStats.bytesReturned[toolName] || 0) + bytes;
  return response;
}

function trackIndexed(bytes: number): void {
  sessionStats.bytesIndexed += bytes;
}

// ==============================================================================
// Security: server-side deny firewall
// ==============================================================================

/**
 * Check a shell command against Bash deny patterns.
 * Returns an error ToolResult if denied, or null if allowed.
 */
function checkDenyPolicy(
  command: string,
  toolName: string,
): ToolResult | null {
  try {
    const policies = readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    const result = evaluateCommandDenyOnly(command, policies);
    if (result.decision === "deny") {
      return trackResponse(toolName, {
        content: [{
          type: "text" as const,
          text: `Command blocked by security policy: matches deny pattern ${result.matchedPattern}`,
        }],
        isError: true,
      });
    }
  } catch {
    // Security check failed — allow through (fail-open for server,
    // hooks are the primary enforcement layer)
  }
  return null;
}

/**
 * Check non-shell code for shell-escape calls against deny patterns.
 */
function checkNonShellDenyPolicy(
  code: string,
  language: string,
  toolName: string,
): ToolResult | null {
  try {
    const commands = extractShellCommands(code, language);
    if (commands.length === 0) return null;
    const policies = readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    for (const cmd of commands) {
      const result = evaluateCommandDenyOnly(cmd, policies);
      if (result.decision === "deny") {
        return trackResponse(toolName, {
          content: [{
            type: "text" as const,
            text: `Command blocked by security policy: embedded shell command "${cmd}" matches deny pattern ${result.matchedPattern}`,
          }],
          isError: true,
        });
      }
    }
  } catch {
    // Fail-open
  }
  return null;
}

/**
 * Check a file path against Read deny patterns.
 * Returns an error ToolResult if denied, or null if allowed.
 */
function checkFilePathDenyPolicy(
  filePath: string,
  toolName: string,
): ToolResult | null {
  try {
    const denyGlobs = readToolDenyPatterns("Read", process.env.CLAUDE_PROJECT_DIR);
    const result = evaluateFilePath(filePath, denyGlobs);
    if (result.denied) {
      return trackResponse(toolName, {
        content: [{
          type: "text" as const,
          text: `File access blocked by security policy: path matches Read deny pattern ${result.matchedPattern}`,
        }],
        isError: true,
      });
    }
  } catch {
    // Fail-open
  }
  return null;
}

// Build description dynamically based on detected runtimes
const langList = available.join(", ");
const bunNote = hasBunRuntime()
  ? " (Bun detected — JS/TS runs 3-5x faster)"
  : "";

// ─────────────────────────────────────────────────────────
// Helper: smart snippet extraction — returns windows around
// matching query terms instead of dumb truncation
//
// When `highlighted` is provided (from FTS5 `highlight()` with
// STX/ETX markers), match positions are derived from the markers.
// This is the authoritative source — FTS5 uses the exact same
// tokenizer that produced the BM25 match, so stemmed variants
// like "configuration" matching query "configure" are found
// correctly. Falls back to indexOf on raw terms when highlighted
// is absent (non-FTS codepath).
// ─────────────────────────────────────────────────────────

const STX = "\x02";
const ETX = "\x03";

/**
 * Parse FTS5 highlight markers to find match positions in the
 * original (marker-free) text. Returns character offsets into the
 * stripped content where each matched token begins.
 */
export function positionsFromHighlight(highlighted: string): number[] {
  const positions: number[] = [];
  let cleanOffset = 0;

  let i = 0;
  while (i < highlighted.length) {
    if (highlighted[i] === STX) {
      // Record position of this match in the clean text
      positions.push(cleanOffset);
      i++; // skip STX
      // Advance through matched text until ETX
      while (i < highlighted.length && highlighted[i] !== ETX) {
        cleanOffset++;
        i++;
      }
      if (i < highlighted.length) i++; // skip ETX
    } else {
      cleanOffset++;
      i++;
    }
  }

  return positions;
}

/** Strip STX/ETX markers to recover original content. */
function stripMarkers(highlighted: string): string {
  return highlighted.replaceAll(STX, "").replaceAll(ETX, "");
}

export function extractSnippet(
  content: string,
  query: string,
  maxLen = 1500,
  highlighted?: string,
): string {
  if (content.length <= maxLen) return content;

  // Derive match positions from FTS5 highlight markers when available
  const positions: number[] = [];

  if (highlighted) {
    for (const pos of positionsFromHighlight(highlighted)) {
      positions.push(pos);
    }
  }

  // Fallback: indexOf on raw query terms (non-FTS codepath)
  if (positions.length === 0) {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    const lower = content.toLowerCase();

    for (const term of terms) {
      let idx = lower.indexOf(term);
      while (idx !== -1) {
        positions.push(idx);
        idx = lower.indexOf(term, idx + 1);
      }
    }
  }

  // No matches at all — return prefix
  if (positions.length === 0) {
    return content.slice(0, maxLen) + "\n…";
  }

  // Sort positions, merge overlapping windows
  positions.sort((a, b) => a - b);
  const WINDOW = 300;
  const windows: Array<[number, number]> = [];

  for (const pos of positions) {
    const start = Math.max(0, pos - WINDOW);
    const end = Math.min(content.length, pos + WINDOW);
    if (windows.length > 0 && start <= windows[windows.length - 1][1]) {
      windows[windows.length - 1][1] = end;
    } else {
      windows.push([start, end]);
    }
  }

  // Collect windows until maxLen
  const parts: string[] = [];
  let total = 0;
  for (const [start, end] of windows) {
    if (total >= maxLen) break;
    const part = content.slice(start, Math.min(end, start + (maxLen - total)));
    parts.push(
      (start > 0 ? "…" : "") + part + (end < content.length ? "…" : ""),
    );
    total += part.length;
  }

  return parts.join("\n\n");
}

export function formatBatchQueryResults(
  store: ContentStore,
  queries: string[],
  source: string,
  maxOutput = 80 * 1024,
): string[] {
  const sections: string[] = [];
  let outputSize = 0;

  for (const query of queries) {
    if (outputSize > maxOutput) {
      sections.push(`## ${query}\n(output cap reached — use search(queries: ["${query}"]) for details)\n`);
      continue;
    }

    const results = store.searchWithFallback(query, 3, source, undefined, "exact");
    sections.push(`## ${query}`);
    sections.push("");
    if (results.length > 0) {
      for (const result of results) {
        const snippet = extractSnippet(result.content, query, 3000, result.highlighted);
        sections.push(`### ${result.title}`);
        sections.push(snippet);
        sections.push("");
        outputSize += snippet.length + result.title.length;
      }
      continue;
    }

    sections.push("No matching sections found.");
    sections.push("");
  }

  sections.push(`\n> **Tip:** Results are scoped to this batch only. To search across all indexed sources, use \`ctx_search(queries: [...])\`.`);

  return sections;
}

// ─────────────────────────────────────────────────────────
// Tool: execute
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_execute",
  {
    title: "Execute Code",
    description: `MANDATORY: Use for any command where output exceeds 20 lines. Execute code in a sandboxed subprocess. Only stdout enters context — raw data stays in the subprocess.${bunNote} Available: ${langList}.\n\nPREFER THIS OVER BASH for: API calls (gh, curl, aws), test runners (npm test, pytest), git queries (git log, git diff), data processing, and ANY CLI command that may produce large output. Bash should only be used for file mutations, git writes, and navigation.`,
    inputSchema: z.object({
      language: z
        .enum([
          "javascript",
          "typescript",
          "python",
          "shell",
          "ruby",
          "go",
          "rust",
          "php",
          "perl",
          "r",
          "elixir",
        ])
        .describe("Runtime language"),
      code: z
        .string()
        .describe(
          "Source code to execute. Use console.log (JS/TS), print (Python/Ruby/Perl/R), echo (Shell), echo (PHP), fmt.Println (Go), or IO.puts (Elixir) to output a summary to context.",
        ),
      timeout: z
        .number()
        .optional()
        .default(30000)
        .describe("Max execution time in ms"),
      background: z
        .boolean()
        .optional()
        .default(false)
        .describe("Keep process running after timeout (for servers/daemons). Returns partial output without killing the process. IMPORTANT: Do NOT add setTimeout/self-close timers in background scripts — the process must stay alive until the timeout detaches it. For server+fetch patterns, prefer putting both server and fetch in ONE ctx_execute call instead of using background."),
      intent: z
        .string()
        .optional()
        .describe(
          "What you're looking for in the output. When provided and output is large (>5KB), " +
          "indexes output into knowledge base and returns section titles + previews — not full content. " +
          "Use search(queries: [...]) to retrieve specific sections. Example: 'failing tests', 'HTTP 500 errors'." +
          "\n\nTIP: Use specific technical terms, not just concepts. Check 'Searchable terms' in the response for available vocabulary.",
        ),
    }),
  },
  async ({ language, code, timeout, background, intent }) => {
    // Security: deny-only firewall
    if (language === "shell") {
      const denied = checkDenyPolicy(code, "execute");
      if (denied) return denied;
    } else {
      const denied = checkNonShellDenyPolicy(code, language, "execute");
      if (denied) return denied;
    }

    try {
      // For JS/TS: wrap in async IIFE with fetch + http/https interceptors to track network bytes
      let instrumentedCode = code;
      if (language === "javascript" || language === "typescript") {
        // Wrap user code in a closure that shadows CJS require with http/https interceptor.
        // globalThis.require does NOT work because CJS require is module-scoped, not global.
        // The closure approach (function(__cm_req){ var require=...; })(require) correctly
        // shadows the CJS require for all code inside, including __cm_main().
        instrumentedCode = `
let __cm_net=0;
// Report network bytes on process exit — works with both promise and callback patterns.
// process.on('exit') fires after all I/O completes, unlike .finally() which fires
// when __cm_main() resolves (immediately for callback-based http.get without await).
process.on('exit',()=>{if(__cm_net>0)try{process.stderr.write('__CM_NET__:'+__cm_net+'\\n')}catch{}});
;(function(__cm_req){
// Intercept globalThis.fetch
const __cm_f=globalThis.fetch;
globalThis.fetch=async(...a)=>{const r=await __cm_f(...a);
try{const cl=r.clone();const b=await cl.arrayBuffer();__cm_net+=b.byteLength}catch{}
return r};
// Shadow CJS require with http/https network tracking.
const __cm_hc=new Map();
const __cm_hm=new Set(['http','https','node:http','node:https']);
function __cm_wf(m,origFn){return function(...a){
  const li=a.length-1;
  if(li>=0&&typeof a[li]==='function'){const oc=a[li];a[li]=function(res){
    res.on('data',function(c){__cm_net+=c.length});oc(res);};}
  const req=origFn.apply(m,a);
  const oOn=req.on.bind(req);
  req.on=function(ev,cb,...r){
    if(ev==='response'){return oOn(ev,function(res){
      res.on('data',function(c){__cm_net+=c.length});cb(res);
    },...r);}
    return oOn(ev,cb,...r);
  };
  return req;
}}
var require=__cm_req?function(id){
  const m=__cm_req(id);
  if(!__cm_hm.has(id))return m;
  const k=id.replace('node:','');
  if(__cm_hc.has(k))return __cm_hc.get(k);
  const w=Object.create(m);
  if(typeof m.get==='function')w.get=__cm_wf(m,m.get);
  if(typeof m.request==='function')w.request=__cm_wf(m,m.request);
  __cm_hc.set(k,w);return w;
}:__cm_req;
if(__cm_req){if(__cm_req.resolve)require.resolve=__cm_req.resolve;
if(__cm_req.cache)require.cache=__cm_req.cache;}
async function __cm_main(){
${code}
}
__cm_main().catch(e=>{console.error(e);process.exitCode=1});${background ? '\nsetInterval(()=>{},2147483647);' : ''}
})(typeof require!=='undefined'?require:null);`;
      }
      const result = await executor.execute({ language, code: instrumentedCode, timeout, background });

      // Parse sandbox network metrics from stderr
      const netMatch = result.stderr?.match(/__CM_NET__:(\d+)/);
      if (netMatch) {
        sessionStats.bytesSandboxed += parseInt(netMatch[1]);
        // Clean the metric line from stderr
        result.stderr = result.stderr.replace(/\n?__CM_NET__:\d+\n?/g, "");
      }

      if (result.timedOut) {
        const partialOutput = result.stdout?.trim();
        if (result.backgrounded && partialOutput) {
          // Background mode: process is still running, return partial output as success
          return trackResponse("ctx_execute", {
            content: [
              {
                type: "text" as const,
                text: `${partialOutput}\n\n_(process backgrounded after ${timeout}ms — still running)_`,
              },
            ],
          });
        }
        if (partialOutput) {
          // Timeout with partial output — return as success with note
          return trackResponse("ctx_execute", {
            content: [
              {
                type: "text" as const,
                text: `${partialOutput}\n\n_(timed out after ${timeout}ms — partial output shown above)_`,
              },
            ],
          });
        }
        return trackResponse("ctx_execute", {
          content: [
            {
              type: "text" as const,
              text: `Execution timed out after ${timeout}ms\n\nstderr:\n${result.stderr}`,
            },
          ],
          isError: true,
        });
      }

      if (result.exitCode !== 0) {
        const { isError, output } = classifyNonZeroExit({
          language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
        });
        if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute", {
            content: [
              { type: "text" as const, text: intentSearch(output, intent, isError ? `execute:${language}:error` : `execute:${language}`) },
            ],
            isError,
          });
        }
        // Auto-index large error output into FTS5 — no data loss
        if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute", {
            content: [
              { type: "text" as const, text: intentSearch(output, "errors failures exceptions", isError ? `execute:${language}:error` : `execute:${language}`) },
            ],
            isError,
          });
        }
        return trackResponse("ctx_execute", {
          content: [
            { type: "text" as const, text: output },
          ],
          isError,
        });
      }

      const stdout = result.stdout || "(no output)";

      // Intent-driven search: if intent provided and output is large enough
      if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
        trackIndexed(Buffer.byteLength(stdout));
        return trackResponse("ctx_execute", {
          content: [
            { type: "text" as const, text: intentSearch(stdout, intent, `execute:${language}`) },
          ],
        });
      }

      // Auto-index large stdout into FTS5 — return pointer, not raw content
      if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
        return trackResponse("ctx_execute", indexStdout(stdout, `execute:${language}`));
      }

      return trackResponse("ctx_execute", {
        content: [
          { type: "text" as const, text: stdout },
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_execute", {
        content: [
          { type: "text" as const, text: `Runtime error: ${message}` },
        ],
        isError: true,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────
// Helper: index stdout into FTS5 knowledge base
// ─────────────────────────────────────────────────────────

function indexStdout(
  stdout: string,
  source: string,
): { content: Array<{ type: "text"; text: string }> } {
  const store = getStore();
  trackIndexed(Buffer.byteLength(stdout));
  const indexed = store.index({ content: stdout, source });
  return {
    content: [
      {
        type: "text" as const,
        text: `Indexed ${indexed.totalChunks} sections (${indexed.codeChunks} with code) from: ${indexed.label}\nUse search(queries: ["..."]) to query this content. Use source: "${indexed.label}" to scope results.`,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────
// Helper: intent-driven search on execution output
// ─────────────────────────────────────────────────────────

const INTENT_SEARCH_THRESHOLD = 5_000; // bytes — ~80-100 lines
const LARGE_OUTPUT_THRESHOLD = 102_400; // 100KB — auto-index into FTS5, return pointer

function intentSearch(
  stdout: string,
  intent: string,
  source: string,
  maxResults: number = 5,
): string {
  const totalLines = stdout.split("\n").length;
  const totalBytes = Buffer.byteLength(stdout);

  // Index into the PERSISTENT store so user can search() later
  const persistent = getStore();
  const indexed = persistent.indexPlainText(stdout, source);

  // Search the persistent store directly (porter → trigram → fuzzy)
  let results = persistent.searchWithFallback(intent, maxResults, source);

  // Extract distinctive terms as vocabulary hints for the LLM
  const distinctiveTerms = persistent.getDistinctiveTerms(indexed.sourceId);

  if (results.length === 0) {
    const lines = [
      `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
      `No sections matched intent "${intent}" in ${totalLines}-line output (${(totalBytes / 1024).toFixed(1)}KB).`,
    ];
    if (distinctiveTerms.length > 0) {
      lines.push("");
      lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
    }
    lines.push("");
    lines.push("Use search() to explore the indexed content.");
    return lines.join("\n");
  }

  // Return ONLY titles + first-line previews — not full content
  const lines = [
    `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
    `${results.length} sections matched "${intent}" (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB):`,
    "",
  ];

  for (const r of results) {
    const preview = r.content.split("\n")[0].slice(0, 120);
    lines.push(`  - ${r.title}: ${preview}`);
  }

  if (distinctiveTerms.length > 0) {
    lines.push("");
    lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
  }

  lines.push("");
  lines.push("Use search(queries: [...]) to retrieve full content of any section.");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────
// Tool: execute_file
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_execute_file",
  {
    title: "Execute File Processing",
    description:
      "Read a file and process it without loading contents into context. The file is read into a FILE_CONTENT variable inside the sandbox. Only your printed summary enters context.\n\nPREFER THIS OVER Read/cat for: log files, data files (CSV, JSON, XML), large source files for analysis, and any file where you need to extract specific information rather than read the entire content.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("Absolute file path or relative to project root"),
      language: z
        .enum([
          "javascript",
          "typescript",
          "python",
          "shell",
          "ruby",
          "go",
          "rust",
          "php",
          "perl",
          "r",
          "elixir",
        ])
        .describe("Runtime language"),
      code: z
        .string()
        .describe(
          "Code to process FILE_CONTENT (file_content in Elixir). Print summary via console.log/print/echo/IO.puts.",
        ),
      timeout: z
        .number()
        .optional()
        .default(30000)
        .describe("Max execution time in ms"),
      intent: z
        .string()
        .optional()
        .describe(
          "What you're looking for in the output. When provided and output is large (>5KB), " +
          "returns only matching sections via BM25 search instead of truncated output.",
        ),
    }),
  },
  async ({ path, language, code, timeout, intent }) => {
    // Security: check file path against Read deny patterns
    const pathDenied = checkFilePathDenyPolicy(path, "execute_file");
    if (pathDenied) return pathDenied;

    // Security: check code parameter against Bash deny patterns
    if (language === "shell") {
      const codeDenied = checkDenyPolicy(code, "execute_file");
      if (codeDenied) return codeDenied;
    } else {
      const codeDenied = checkNonShellDenyPolicy(code, language, "execute_file");
      if (codeDenied) return codeDenied;
    }

    try {
      const result = await executor.executeFile({
        path,
        language,
        code,
        timeout,
      });

      if (result.timedOut) {
        return trackResponse("ctx_execute_file", {
          content: [
            {
              type: "text" as const,
              text: `Timed out processing ${path} after ${timeout}ms`,
            },
          ],
          isError: true,
        });
      }

      if (result.exitCode !== 0) {
        const { isError, output } = classifyNonZeroExit({
          language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
        });
        if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute_file", {
            content: [
              { type: "text" as const, text: intentSearch(output, intent, isError ? `file:${path}:error` : `file:${path}`) },
            ],
            isError,
          });
        }
        // Auto-index large error output into FTS5 — no data loss
        if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute_file", {
            content: [
              { type: "text" as const, text: intentSearch(output, "errors failures exceptions", isError ? `file:${path}:error` : `file:${path}`) },
            ],
            isError,
          });
        }
        return trackResponse("ctx_execute_file", {
          content: [
            { type: "text" as const, text: output },
          ],
          isError,
        });
      }

      const stdout = result.stdout || "(no output)";

      if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
        trackIndexed(Buffer.byteLength(stdout));
        return trackResponse("ctx_execute_file", {
          content: [
            { type: "text" as const, text: intentSearch(stdout, intent, `file:${path}`) },
          ],
        });
      }

      // Auto-index large stdout into FTS5 — return pointer, not raw content
      if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
        return trackResponse("ctx_execute_file", indexStdout(stdout, `file:${path}`));
      }

      return trackResponse("ctx_execute_file", {
        content: [
          { type: "text" as const, text: stdout },
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_execute_file", {
        content: [
          { type: "text" as const, text: `Runtime error: ${message}` },
        ],
        isError: true,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: index
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_index",
  {
    title: "Index Content",
    description:
      "Index documentation or knowledge content into a searchable BM25 knowledge base. " +
      "Chunks markdown by headings (keeping code blocks intact) and stores in ephemeral FTS5 database. " +
      "The full content does NOT stay in context — only a brief summary is returned.\n\n" +
      "WHEN TO USE:\n" +
      "- Documentation from Context7, Skills, or MCP tools (API docs, framework guides, code examples)\n" +
      "- API references (endpoint details, parameter specs, response schemas)\n" +
      "- MCP tools/list output (exact tool signatures and descriptions)\n" +
      "- Skill prompts and instructions that are too large for context\n" +
      "- README files, migration guides, changelog entries\n" +
      "- Any content with code examples you may need to reference precisely\n\n" +
      "After indexing, use 'search' to retrieve specific sections on-demand.\n" +
      "Do NOT use for: log files, test output, CSV, build output — use 'execute_file' for those.",
    inputSchema: z.object({
      content: z
        .string()
        .optional()
        .describe(
          "Raw text/markdown to index. Provide this OR path, not both.",
        ),
      path: z
        .string()
        .optional()
        .describe(
          "File path to read and index (content never enters context). Provide this OR content.",
        ),
      source: z
        .string()
        .optional()
        .describe(
          "Label for the indexed content (e.g., 'Context7: React useEffect', 'Skill: frontend-design')",
        ),
    }),
  },
  async ({ content, path, source }) => {
    if (!content && !path) {
      return trackResponse("ctx_index", {
        content: [
          {
            type: "text" as const,
            text: "Error: Either content or path must be provided",
          },
        ],
        isError: true,
      });
    }

    try {
      // Track the raw bytes being indexed (content or file)
      if (content) trackIndexed(Buffer.byteLength(content));
      else if (path) {
        try {
          const fs = await import("fs");
          trackIndexed(fs.readFileSync(path).byteLength);
        } catch { /* ignore — file read errors handled by store */ }
      }
      const store = getStore();
      const result = store.index({ content, path, source });

      return trackResponse("ctx_index", {
        content: [
          {
            type: "text" as const,
            text: `Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from: ${result.label}\nUse search(queries: ["..."]) to query this content. Use source: "${result.label}" to scope results.`,
          },
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_index", {
        content: [
          { type: "text" as const, text: `Index error: ${message}` },
        ],
        isError: true,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: search — progressive throttling
// ─────────────────────────────────────────────────────────

// Track search calls per 60-second window for progressive throttling
let searchCallCount = 0;
let searchWindowStart = Date.now();
const SEARCH_WINDOW_MS = 60_000;
const SEARCH_MAX_RESULTS_AFTER = 3; // after 3 calls: 1 result per query
const SEARCH_BLOCK_AFTER = 8; // after 8 calls: refuse, demand batching

/**
 * Defensive coercion: parse stringified JSON arrays.
 * Works around Claude Code double-serialization bug where array params
 * are sent as JSON strings (e.g. "[\"a\",\"b\"]" instead of ["a","b"]).
 * See: https://github.com/anthropics/claude-code/issues/34520
 */
function coerceJsonArray(val: unknown): unknown {
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not valid JSON, let zod handle the error */ }
  }
  return val;
}

/**
 * Coerce commands array: handles double-serialization AND the case where
 * the model passes plain command strings instead of {label, command} objects.
 */
function coerceCommandsArray(val: unknown): unknown {
  const arr = coerceJsonArray(val);
  if (Array.isArray(arr)) {
    return arr.map((item, i) =>
      typeof item === "string" ? { label: `cmd_${i + 1}`, command: item } : item
    );
  }
  return arr;
}

server.registerTool(
  "ctx_search",
  {
    title: "Search Indexed Content",
    description:
      "Search indexed content. Requires prior indexing via ctx_batch_execute, ctx_index, or ctx_fetch_and_index. " +
      "Pass ALL search questions as queries array in ONE call.\n\n" +
      "TIPS: 2-4 specific terms per query. Use 'source' to scope results.",
    inputSchema: z.object({
      queries: z.preprocess(coerceJsonArray, z
        .array(z.string())
        .optional()
        .describe("Array of search queries. Batch ALL questions in one call.")),
      limit: z
        .number()
        .optional()
        .default(3)
        .describe("Results per query (default: 3)"),
      source: z
        .string()
        .optional()
        .describe("Filter to a specific indexed source (partial match)."),
      contentType: z
        .enum(["code", "prose"])
        .optional()
        .describe("Filter results by content type: 'code' or 'prose'."),
    }),
  },
  async (params) => {
    try {
      const store = getStore();

      // Guard: redirect when the index is empty — ctx_search is a follow-up
      // tool that requires prior indexing. Guide the model to the right tool.
      if (store.getStats().chunks === 0) {
        return trackResponse("ctx_search", {
          content: [{
            type: "text" as const,
            text: "Knowledge base is empty — no content has been indexed yet.\n\n" +
              "ctx_search is a follow-up tool that queries previously indexed content. " +
              "To gather and index content first, use:\n" +
              "  • ctx_batch_execute(commands, queries) — run commands, auto-index output, and search in one call\n" +
              "  • ctx_fetch_and_index(url) — fetch a URL, index it, then search with ctx_search\n" +
              "  • ctx_index(content, source) — manually index text content\n\n" +
              "After indexing, ctx_search becomes available for follow-up queries.",
          }],
          isError: true,
        });
      }

      const raw = params as Record<string, unknown>;

      // Normalize: accept both query (string) and queries (array)
      const queryList: string[] = [];
      if (Array.isArray(raw.queries) && raw.queries.length > 0) {
        queryList.push(...(raw.queries as string[]));
      } else if (typeof raw.query === "string" && raw.query.length > 0) {
        queryList.push(raw.query as string);
      }

      if (queryList.length === 0) {
        return trackResponse("ctx_search", {
          content: [{ type: "text" as const, text: "Error: provide query or queries." }],
          isError: true,
        });
      }

      const { limit = 3, source, contentType } = params as { limit?: number; source?: string; contentType?: "code" | "prose" };

      // Progressive throttling: track calls in time window
      const now = Date.now();
      if (now - searchWindowStart > SEARCH_WINDOW_MS) {
        searchCallCount = 0;
        searchWindowStart = now;
      }
      searchCallCount++;

      // After SEARCH_BLOCK_AFTER calls: refuse
      if (searchCallCount > SEARCH_BLOCK_AFTER) {
        return trackResponse("ctx_search", {
          content: [{
            type: "text" as const,
            text: `BLOCKED: ${searchCallCount} search calls in ${Math.round((now - searchWindowStart) / 1000)}s. ` +
              "You're flooding context. STOP making individual search calls. " +
              "Use batch_execute(commands, queries) for your next research step.",
          }],
          isError: true,
        });
      }

      // Determine per-query result limit based on throttle level
      const effectiveLimit = searchCallCount > SEARCH_MAX_RESULTS_AFTER
        ? 1 // after 3 calls: only 1 result per query
        : Math.min(limit, 2); // normal: max 2

      const MAX_TOTAL = 40 * 1024; // 40KB total cap
      let totalSize = 0;
      const sections: string[] = [];

      for (const q of queryList) {
        if (totalSize > MAX_TOTAL) {
          sections.push(`## ${q}\n(output cap reached)\n`);
          continue;
        }

        const results = store.searchWithFallback(q, effectiveLimit, source, contentType);

        if (results.length === 0) {
          sections.push(`## ${q}\nNo results found.`);
          continue;
        }

        const formatted = results
          .map((r, i) => {
            const header = `--- [${r.source}] ---`;
            const heading = `### ${r.title}`;
            const snippet = extractSnippet(r.content, q, 1500, r.highlighted);
            return `${header}\n${heading}\n\n${snippet}`;
          })
          .join("\n\n");

        sections.push(`## ${q}\n\n${formatted}`);
        totalSize += formatted.length;
      }

      let output = sections.join("\n\n---\n\n");

      // Add throttle warning after threshold
      if (searchCallCount >= SEARCH_MAX_RESULTS_AFTER) {
        output += `\n\n⚠ search call #${searchCallCount}/${SEARCH_BLOCK_AFTER} in this window. ` +
          `Results limited to ${effectiveLimit}/query. ` +
          `Batch queries: search(queries: ["q1","q2","q3"]) or use batch_execute.`;
      }

      if (output.trim().length === 0) {
        const sources = store.listSources();
        const sourceList = sources.length > 0
          ? `\nIndexed sources: ${sources.map((s) => `"${s.label}" (${s.chunkCount} sections)`).join(", ")}`
          : "";
        return trackResponse("ctx_search", {
          content: [{ type: "text" as const, text: `No results found.${sourceList}` }],
        });
      }

      return trackResponse("ctx_search", {
        content: [{ type: "text" as const, text: output }],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_search", {
        content: [{ type: "text" as const, text: `Search error: ${message}` }],
        isError: true,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────
// Turndown path resolution (external dep, like better-sqlite3)
// ─────────────────────────────────────────────────────────

let _turndownPath: string | null = null;
let _gfmPluginPath: string | null = null;

function resolveTurndownPath(): string {
  if (!_turndownPath) {
    const require = createRequire(import.meta.url);
    _turndownPath = require.resolve("turndown");
  }
  return _turndownPath;
}

function resolveGfmPluginPath(): string {
  if (!_gfmPluginPath) {
    const require = createRequire(import.meta.url);
    _gfmPluginPath = require.resolve("turndown-plugin-gfm");
  }
  return _gfmPluginPath;
}

// ─────────────────────────────────────────────────────────
// Tool: fetch_and_index
// ─────────────────────────────────────────────────────────

// Subprocess code that fetches a URL, detects Content-Type, and outputs a
// __CM_CT__:<type> marker on the first line so the handler can route to the
// appropriate indexing strategy.  HTML is converted to markdown via Turndown.
function buildFetchCode(url: string, outputPath: string): string {
  const turndownPath = JSON.stringify(resolveTurndownPath());
  const gfmPath = JSON.stringify(resolveGfmPluginPath());
  const escapedOutputPath = JSON.stringify(outputPath);
  return `
const TurndownService = require(${turndownPath});
const { gfm } = require(${gfmPath});
const fs = require('fs');
const url = ${JSON.stringify(url)};
const outputPath = ${escapedOutputPath};

function emit(ct, content) {
  // Write content to file to bypass executor stdout truncation (100KB limit).
  // Only the content-type marker goes to stdout.
  fs.writeFileSync(outputPath, content);
  console.log('__CM_CT__:' + ct);
}

async function main() {
  const resp = await fetch(url);
  if (!resp.ok) { console.error("HTTP " + resp.status); process.exit(1); }
  const contentType = resp.headers.get('content-type') || '';

  // --- JSON responses ---
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    const text = await resp.text();
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      emit('json', pretty);
    } catch {
      emit('text', text);
    }
    return;
  }

  // --- HTML responses (default for text/html, application/xhtml+xml) ---
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const html = await resp.text();
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    td.use(gfm);
    td.remove(['script', 'style', 'nav', 'header', 'footer', 'noscript']);
    emit('html', td.turndown(html));
    return;
  }

  // --- Everything else: plain text, CSV, XML, etc. ---
  const text = await resp.text();
  emit('text', text);
}
main();
`;
}

server.registerTool(
  "ctx_fetch_and_index",
  {
    title: "Fetch & Index URL",
    description:
      "Fetches URL content, converts HTML to markdown, indexes into searchable knowledge base, " +
      "and returns a ~3KB preview. Full content stays in sandbox — use search() for deeper lookups.\n\n" +
      "Better than WebFetch: preview is immediate, full content is searchable, raw HTML never enters context.\n\n" +
      "Content-type aware: HTML is converted to markdown, JSON is chunked by key paths, plain text is indexed directly.",
    inputSchema: z.object({
      url: z.string().describe("The URL to fetch and index"),
      source: z
        .string()
        .optional()
        .describe(
          "Label for the indexed content (e.g., 'React useEffect docs', 'Supabase Auth API')",
        ),
      force: z
        .boolean()
        .optional()
        .describe("Skip cache and re-fetch even if content was recently indexed"),
    }),
  },
  async ({ url, source, force }) => {
    // TTL cache: if source was indexed within 24h, return cached hint
    if (!force) {
      const store = getStore();
      const label = source ?? url;
      const meta = store.getSourceMeta(label);
      if (meta) {
        const indexedAt = new Date(meta.indexedAt + "Z"); // SQLite datetime is UTC without Z
        const ageMs = Date.now() - indexedAt.getTime();
        const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
        if (ageMs < TTL_MS) {
          const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
          const ageMin = Math.floor(ageMs / (60 * 1000));
          const ageStr = ageHours > 0 ? `${ageHours}h ago` : ageMin > 0 ? `${ageMin}m ago` : "just now";
          // Track cache savings — estimate ~1.6KB per chunk (average indexed content size)
          const estimatedBytes = meta.chunkCount * 1600;
          sessionStats.cacheHits++;
          sessionStats.cacheBytesSaved += estimatedBytes;

          return trackResponse("ctx_fetch_and_index", {
            content: [{
              type: "text" as const,
              text: `Cached: **${meta.label}** — ${meta.chunkCount} sections, indexed ${ageStr} (fresh, TTL: 24h).\nTo refresh: call ctx_fetch_and_index again with \`force: true\`.\n\nYou MUST call search() to answer questions about this content — this cached response contains no content.\nUse: search(queries: [...], source: "${meta.label}")`,
            }],
          });
        }
        // Stale (>24h) — fall through to re-fetch silently
      }
    }
    // Generate a unique temp file path for the subprocess to write fetched content.
    // This bypasses the executor's 100KB stdout truncation — content goes file→handler directly.
    const outputPath = join(tmpdir(), `ctx-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.dat`);

    try {
      const fetchCode = buildFetchCode(url, outputPath);
      const result = await executor.execute({
        language: "javascript",
        code: fetchCode,
        timeout: 30_000,
      });

      if (result.exitCode !== 0) {
        return trackResponse("ctx_fetch_and_index", {
          content: [
            {
              type: "text" as const,
              text: `Failed to fetch ${url}: ${result.stderr || result.stdout}`,
            },
          ],
          isError: true,
        });
      }

      // Parse content-type marker from stdout (content is in the temp file)
      const store = getStore();
      const header = (result.stdout || "").trim();

      // Read full content from temp file
      let markdown: string;
      try {
        markdown = readFileSync(outputPath, "utf-8").trim();
      } catch {
        return trackResponse("ctx_fetch_and_index", {
          content: [
            {
              type: "text" as const,
              text: `Fetched ${url} but could not read subprocess output`,
            },
          ],
          isError: true,
        });
      }

      if (markdown.length === 0) {
        return trackResponse("ctx_fetch_and_index", {
          content: [
            {
              type: "text" as const,
              text: `Fetched ${url} but got empty content`,
            },
          ],
          isError: true,
        });
      }

      trackIndexed(Buffer.byteLength(markdown));

      // Route to the appropriate indexing strategy based on Content-Type
      let indexed: IndexResult;
      if (header === "__CM_CT__:json") {
        indexed = store.indexJSON(markdown, source ?? url);
      } else if (header === "__CM_CT__:text") {
        indexed = store.indexPlainText(markdown, source ?? url);
      } else {
        // HTML (default) — content is already converted to markdown
        indexed = store.index({ content: markdown, source: source ?? url });
      }

      // Build preview — first ~3KB of markdown for immediate use
      const PREVIEW_LIMIT = 3072;
      const preview = markdown.length > PREVIEW_LIMIT
        ? markdown.slice(0, PREVIEW_LIMIT) + "\n\n…[truncated — use search() for full content]"
        : markdown;
      const totalKB = (Buffer.byteLength(markdown) / 1024).toFixed(1);

      const text = [
        `Fetched and indexed **${indexed.totalChunks} sections** (${totalKB}KB) from: ${indexed.label}`,
        `Full content indexed in sandbox — use search(queries: [...], source: "${indexed.label}") for specific lookups.`,
        "",
        "---",
        "",
        preview,
      ].join("\n");

      return trackResponse("ctx_fetch_and_index", {
        content: [{ type: "text" as const, text }],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_fetch_and_index", {
        content: [
          { type: "text" as const, text: `Fetch error: ${message}` },
        ],
        isError: true,
      });
    } finally {
      // Clean up temp file
      try { rmSync(outputPath); } catch { /* already gone */ }
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: batch_execute
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_batch_execute",
  {
    title: "Batch Execute & Search",
    description:
      "Execute multiple commands in ONE call, auto-index all output, and search with multiple queries. " +
      "Returns search results directly — no follow-up calls needed.\n\n" +
      "THIS IS THE PRIMARY TOOL. Use this instead of multiple execute() calls.\n\n" +
      "One batch_execute call replaces 30+ execute calls + 10+ search calls.\n" +
      "Provide all commands to run and all queries to search — everything happens in one round trip.",
    inputSchema: z.object({
      commands: z.preprocess(coerceCommandsArray, z
        .array(
          z.object({
            label: z
              .string()
              .describe(
                "Section header for this command's output (e.g., 'README', 'Package.json', 'Source Tree')",
              ),
            command: z
              .string()
              .describe("Shell command to execute"),
          }),
        )
        .min(1)
        .describe(
          "Commands to execute as a batch. Each runs sequentially, output is labeled with the section header.",
        )),
      queries: z.preprocess(coerceJsonArray, z
        .array(z.string())
        .min(1)
        .describe(
          "Search queries to extract information from indexed output. Use 5-8 comprehensive queries. " +
          "Each returns top 5 matching sections with full content. " +
          "This is your ONLY chance — put ALL your questions here. No follow-up calls needed.",
        )),
      timeout: z
        .number()
        .optional()
        .default(60000)
        .describe("Max execution time in ms (default: 60s)"),
    }),
  },
  async ({ commands, queries, timeout }) => {
    // Security: check each command against deny patterns
    for (const cmd of commands) {
      const denied = checkDenyPolicy(cmd.command, "batch_execute");
      if (denied) return denied;
    }

    try {
      // Execute each command individually so every command gets its own
      // output capture. Full stdout is preserved and indexed into FTS5.
      // (Issue #61, #197)
      const perCommandOutputs: string[] = [];
      const startTime = Date.now();
      let timedOut = false;

      for (const cmd of commands) {
        const elapsed = Date.now() - startTime;
        const remaining = timeout - elapsed;
        if (remaining <= 0) {
          perCommandOutputs.push(
            `# ${cmd.label}\n\n(skipped — batch timeout exceeded)\n`,
          );
          timedOut = true;
          continue;
        }

        const result = await executor.execute({
          language: "shell",
          code: `${cmd.command} 2>&1`,
          timeout: remaining,
        });

        const output = result.stdout || "(no output)";
        perCommandOutputs.push(`# ${cmd.label}\n\n${output}\n`);

        if (result.timedOut) {
          timedOut = true;
          // Mark remaining commands as skipped
          const idx = commands.indexOf(cmd);
          for (let i = idx + 1; i < commands.length; i++) {
            perCommandOutputs.push(
              `# ${commands[i].label}\n\n(skipped — batch timeout exceeded)\n`,
            );
          }
          break;
        }
      }

      const stdout = perCommandOutputs.join("\n");
      const totalBytes = Buffer.byteLength(stdout);
      const totalLines = stdout.split("\n").length;

      if (timedOut && perCommandOutputs.length === 0) {
        return trackResponse("ctx_batch_execute", {
          content: [
            {
              type: "text" as const,
              text: `Batch timed out after ${timeout}ms. No output captured.`,
            },
          ],
          isError: true,
        });
      }

      // Track indexed bytes (raw data that stays in sandbox)
      trackIndexed(totalBytes);

      // Index into knowledge base — markdown heading chunking splits by # labels
      const store = getStore();
      const source = `batch:${commands
        .map((c) => c.label)
        .join(",")
        .slice(0, 80)}`;
      const indexed = store.index({ content: stdout, source });

      // Build section inventory — direct query by source_id (no FTS5 MATCH needed)
      const allSections = store.getChunksBySource(indexed.sourceId);
      const inventory: string[] = ["## Indexed Sections", ""];
      const sectionTitles: string[] = [];
      for (const s of allSections) {
        const bytes = Buffer.byteLength(s.content);
        inventory.push(`- ${s.title} (${(bytes / 1024).toFixed(1)}KB)`);
        sectionTitles.push(s.title);
      }

      // Run all search queries — source scoped only.
      // Cross-source search remains available via explicit search().
      const queryResults = formatBatchQueryResults(store, queries, source);

      // Get searchable terms for edge cases where follow-up is needed
      const distinctiveTerms = store.getDistinctiveTerms
        ? store.getDistinctiveTerms(indexed.sourceId)
        : [];

      const output = [
        `Executed ${commands.length} commands (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB). ` +
          `Indexed ${indexed.totalChunks} sections. Searched ${queries.length} queries.`,
        "",
        ...inventory,
        "",
        ...queryResults,
        distinctiveTerms.length > 0
          ? `\nSearchable terms for follow-up: ${distinctiveTerms.join(", ")}`
          : "",
      ].join("\n");

      return trackResponse("ctx_batch_execute", {
        content: [{ type: "text" as const, text: output }],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_batch_execute", {
        content: [
          {
            type: "text" as const,
            text: `Batch execution error: ${message}`,
          },
        ],
        isError: true,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: stats
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_stats",
  {
    title: "Session Statistics",
    description:
      "Returns context consumption statistics for the current session. " +
      "Shows total bytes returned to context, breakdown by tool, call counts, " +
      "estimated token usage, and context savings ratio.",
    inputSchema: z.object({
      reset: z.boolean().optional().describe("Reset all stats and FTS5 store to zero. Use after /clear."),
    }),
  },
  async ({ reset }) => {
    // Check for clear flag BEFORE reading stats
    checkClearStatsFlag();

    if (reset) {
      resetSessionStats();
      return trackResponse("ctx_stats", {
        content: [{ type: "text" as const, text: "Session stats and search index reset." }],
      });
    }
    const totalBytesReturned = Object.values(sessionStats.bytesReturned).reduce(
      (sum, b) => sum + b,
      0,
    );
    const totalCalls = Object.values(sessionStats.calls).reduce(
      (sum, c) => sum + c,
      0,
    );
    const uptimeMs = Date.now() - sessionStats.sessionStart;
    const uptimeMin = (uptimeMs / 60_000).toFixed(1);

    // Total data kept out of context = indexed (FTS5) + sandboxed (network I/O inside sandbox)
    const keptOut = sessionStats.bytesIndexed + sessionStats.bytesSandboxed;
    const totalProcessed = keptOut + totalBytesReturned;
    const savingsRatio = totalProcessed / Math.max(totalBytesReturned, 1);
    const reductionPct = totalProcessed > 0
      ? ((1 - totalBytesReturned / totalProcessed) * 100).toFixed(0)
      : "0";

    const kb = (b: number) => {
      if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
      return `${(b / 1024).toFixed(1)}KB`;
    };

    // ── Header ──
    const lines: string[] = [
      `## context-mode — Session Report (${uptimeMin} min)`,
    ];

    // ── Feature 1: Context Window Protection ──
    lines.push(
      "",
      `### Context Window Protection`,
      "",
    );

    if (totalCalls === 0) {
      lines.push(`No context-mode tool calls yet. Use \`batch_execute\`, \`execute\`, or \`fetch_and_index\` to keep raw output out of your context window.`);
    } else {
      lines.push(
        `| Metric | Value |`,
        `|--------|------:|`,
        `| Total data processed | **${kb(totalProcessed)}** |`,
        `| Kept in sandbox (never entered context) | **${kb(keptOut)}** |`,
        `| Entered context | ${kb(totalBytesReturned)} |`,
        `| Estimated tokens saved | ~${Math.round(keptOut / 4).toLocaleString()} |`,
        `| **Context savings** | **${savingsRatio.toFixed(1)}x (${reductionPct}% reduction)** |`,
      );

      // Per-tool breakdown
      const toolNames = new Set([
        ...Object.keys(sessionStats.calls),
        ...Object.keys(sessionStats.bytesReturned),
      ]);

      if (toolNames.size > 0) {
        lines.push(
          "",
          `| Tool | Calls | Context | Tokens |`,
          `|------|------:|--------:|-------:|`,
        );
        for (const tool of Array.from(toolNames).sort()) {
          const calls = sessionStats.calls[tool] || 0;
          const bytes = sessionStats.bytesReturned[tool] || 0;
          const tokens = Math.round(bytes / 4);
          lines.push(`| ${tool} | ${calls} | ${kb(bytes)} | ~${tokens.toLocaleString()} |`);
        }
        lines.push(`| **Total** | **${totalCalls}** | **${kb(totalBytesReturned)}** | **~${Math.round(totalBytesReturned / 4).toLocaleString()}** |`);
      }

      if (keptOut > 0) {
        lines.push("", `Without context-mode, **${kb(totalProcessed)}** of raw output would flood your context window. Instead, **${reductionPct}%** stayed in sandbox.`);
      }

      // Cache savings section
      if (sessionStats.cacheHits > 0 || sessionStats.cacheBytesSaved > 0) {
        const totalWithCache = totalProcessed + sessionStats.cacheBytesSaved;
        const totalSavingsRatio = totalWithCache / Math.max(totalBytesReturned, 1);
        const ttlHoursLeft = Math.max(0, 24 - Math.floor((Date.now() - sessionStats.sessionStart) / (60 * 60 * 1000)));
        lines.push(
          "",
          `### TTL Cache`,
          "",
          `| Metric | Value |`,
          `|--------|------:|`,
          `| Cache hits | **${sessionStats.cacheHits}** |`,
          `| Data avoided by cache | **${kb(sessionStats.cacheBytesSaved)}** |`,
          `| Network requests saved | **${sessionStats.cacheHits}** |`,
          `| TTL remaining | **~${ttlHoursLeft}h** |`,
          "",
          `Content was already indexed in the knowledge base — ${sessionStats.cacheHits} fetch${sessionStats.cacheHits > 1 ? "es" : ""} skipped entirely. **${kb(sessionStats.cacheBytesSaved)}** of network I/O avoided. Search results served directly from local FTS5 index.`,
        );

        // Update total savings to include cache
        if (totalSavingsRatio > savingsRatio) {
          lines.push("", `**Total context savings (sandbox + cache): ${totalSavingsRatio.toFixed(1)}x** — ${kb(totalWithCache)} processed, only ${kb(totalBytesReturned)} entered context.`);
        }
      }
    }

    // ── Session Continuity ──
    try {
      const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const dbHash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
      const worktreeSuffix = getWorktreeSuffix();
      const sessionDbPath = join(
        homedir(), ".claude", "context-mode", "sessions",
        `${dbHash}${worktreeSuffix}.db`
      );

      if (existsSync(sessionDbPath)) {
        const Database = loadDatabase();
        const sdb = new Database(sessionDbPath, { readonly: true });

        const eventTotal = sdb.prepare("SELECT COUNT(*) as cnt FROM session_events").get() as { cnt: number };
        const byCategory = sdb.prepare(
          "SELECT category, COUNT(*) as cnt FROM session_events GROUP BY category ORDER BY cnt DESC",
        ).all() as Array<{ category: string; cnt: number }>;
        const meta = sdb.prepare(
          "SELECT compact_count FROM session_meta ORDER BY started_at DESC LIMIT 1",
        ).get() as { compact_count: number } | undefined;
        const resume = sdb.prepare(
          "SELECT event_count, consumed FROM session_resume ORDER BY created_at DESC LIMIT 1",
        ).get() as { event_count: number; consumed: number } | undefined;

        if (eventTotal.cnt > 0) {
          const compacts = meta?.compact_count ?? 0;

          // Query actual data per category for preview
          const previewRows = sdb.prepare(
            `SELECT category, type, data FROM session_events ORDER BY id DESC`,
          ).all() as Array<{ category: string; type: string; data: string }>;

          // Build previews: unique values per category
          const previews = new Map<string, Set<string>>();
          for (const row of previewRows) {
            if (!previews.has(row.category)) previews.set(row.category, new Set());
            const set = previews.get(row.category)!;
            if (set.size < 5) {
              let display = row.data;
              if (row.category === "file") {
                display = row.data.split("/").pop() || row.data;
              } else if (row.category === "prompt") {
                display = display.length > 50 ? display.slice(0, 47) + "..." : display;
              }
              if (display.length > 40) display = display.slice(0, 37) + "...";
              set.add(display);
            }
          }

          const categoryLabels: Record<string, string> = {
            file: "Files tracked",
            rule: "Project rules (CLAUDE.md)",
            prompt: "Your requests saved",
            mcp: "Plugin tools used",
            git: "Git operations",
            env: "Environment setup",
            error: "Errors caught",
            task: "Tasks in progress",
            decision: "Your decisions",
            cwd: "Working directory",
            skill: "Skills used",
            subagent: "Delegated work",
            intent: "Session mode",
            data: "Data references",
            role: "Behavioral directives",
          };

          const categoryHints: Record<string, string> = {
            file: "Restored after compact — no need to re-read",
            rule: "Your project instructions survive context resets",
            prompt: "Continues exactly where you left off",
            decision: "Applied automatically — won't ask again",
            task: "Picks up from where it stopped",
            error: "Tracked and monitored across compacts",
            git: "Branch, commit, and repo state preserved",
            env: "Runtime config carried forward",
            mcp: "Tool usage patterns remembered",
            subagent: "Delegation history preserved",
            skill: "Skill invocations tracked",
          };

          lines.push(
            "",
            "### Session Continuity",
            "",
            "| What's preserved | Count | I remember... | Why it matters |",
            "|------------------|------:|---------------|----------------|",
          );
          for (const row of byCategory) {
            const label = categoryLabels[row.category] || row.category;
            const preview = previews.get(row.category);
            const previewStr = preview ? Array.from(preview).join(", ") : "";
            const hint = categoryHints[row.category] || "Survives context resets";
            lines.push(`| ${label} | ${row.cnt} | ${previewStr} | ${hint} |`);
          }
          lines.push(`| **Total** | **${eventTotal.cnt}** | | **Zero knowledge lost on compact** |`);

          lines.push("");
          if (compacts > 0) {
            lines.push(`Context has been compacted **${compacts} time(s)** — session knowledge was preserved each time.`);
          } else {
            lines.push(`When your context compacts, all of this will restore Claude's awareness — no starting from scratch.`);
          }
          if (resume && !resume.consumed) {
            lines.push(`Resume snapshot ready (${resume.event_count} events) for the next compaction.`);
          }

          lines.push("");
          lines.push(`> **Note:** Previous session data is loaded when you start a new session. Without \`--continue\`, old session history is cleaned up to keep the database lean.`);
        }

        sdb.close();
      }
    } catch {
      // Session DB not available or incompatible — skip silently
    }

    // No separate DevRel summary — integrated into feature sections above

    // Formatting directive — ensures all LLMs display the report verbatim
    lines.push(
      "",
      "---",
      "_Display this entire report as-is in your response. Do NOT summarize, collapse, or paraphrase any section._",
    );

    const text = lines.join("\n");
    return trackResponse("ctx_stats", {
      content: [{ type: "text" as const, text }],
    });
  },
);

// ── ctx-doctor: diagnostics (server-side) ─────────────────────────────────
server.registerTool(
  "ctx_doctor",
  {
    title: "Run Diagnostics",
    description:
      "Diagnose context-mode installation. Runs all checks server-side and " +
      "returns results as a markdown checklist. No CLI execution needed.",
    inputSchema: z.object({}),
  },
  async () => {
    const lines: string[] = ["## context-mode doctor", ""];
    // __pkg_dir is build/ for tsc, plugin root for bundle — resolve to plugin root
    const pluginRoot = existsSync(resolve(__pkg_dir, "package.json")) ? __pkg_dir : dirname(__pkg_dir);

    // Runtimes
    const total = 11;
    const pct = ((available.length / total) * 100).toFixed(0);
    lines.push(`- [x] Runtimes: ${available.length}/${total} (${pct}%) — ${available.join(", ")}`);

    // Performance
    if (hasBunRuntime()) {
      lines.push("- [x] Performance: FAST (Bun)");
    } else {
      lines.push("- [-] Performance: NORMAL — install Bun for 3-5x speed boost");
    }

    // Server test
    try {
      const testExecutor = new PolyglotExecutor({ runtimes });
      const result = await testExecutor.execute({ language: "javascript", code: 'console.log("ok");', timeout: 5000 });
      if (result.exitCode === 0 && result.stdout.trim() === "ok") {
        lines.push("- [x] Server test: PASS");
      } else {
        const detail = result.stderr?.trim() ? ` (${result.stderr.trim().slice(0, 200)})` : "";
        lines.push(`- [ ] Server test: FAIL — exit ${result.exitCode}${detail}`);
      }
    } catch (err: unknown) {
      lines.push(`- [ ] Server test: FAIL — ${err instanceof Error ? err.message : err}`);
    }

    // FTS5 / SQLite
    try {
      const Database = loadDatabase();
      const db = new Database(":memory:");
      db.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
      db.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
      const row = db.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content: string } | undefined;
      db.close();
      if (row && row.content === "hello world") {
        lines.push("- [x] FTS5 / SQLite: PASS — native module works");
      } else {
        lines.push("- [ ] FTS5 / SQLite: FAIL — unexpected result");
      }
    } catch (err: unknown) {
      lines.push(`- [ ] FTS5 / SQLite: FAIL — ${err instanceof Error ? err.message : err}`);
    }

    // Hook script
    const hookPath = resolve(pluginRoot, "hooks", "pretooluse.mjs");
    if (existsSync(hookPath)) {
      lines.push(`- [x] Hook script: PASS — ${hookPath}`);
    } else {
      lines.push(`- [ ] Hook script: FAIL — not found at ${hookPath}`);
    }

    // Version
    lines.push(`- [x] Version: v${VERSION}`);

    return trackResponse("ctx_doctor", {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    });
  },
);

// ── ctx-upgrade: upgrade meta-tool ─────────────────────────────────────────
server.registerTool(
  "ctx_upgrade",
  {
    title: "Upgrade Plugin",
    description:
      "Upgrade context-mode to the latest version. Returns a shell command to execute. " +
      "You MUST run the returned command using your shell tool (Bash, shell_execute, " +
      "run_in_terminal, etc.) and display the output as a checklist. " +
      "Tell the user to restart their session after upgrade.",
    inputSchema: z.object({}),
  },
  async () => {
    // __pkg_dir is build/ for tsc, plugin root for bundle — resolve to plugin root
    const pluginRoot = existsSync(resolve(__pkg_dir, "package.json")) ? __pkg_dir : dirname(__pkg_dir);
    const bundlePath = resolve(pluginRoot, "cli.bundle.mjs");
    const fallbackPath = resolve(pluginRoot, "build", "cli.js");

    let cmd: string;

    if (existsSync(bundlePath)) {
      cmd = `node "${bundlePath}" upgrade`;
    } else if (existsSync(fallbackPath)) {
      cmd = `node "${fallbackPath}" upgrade`;
    } else {
      // Inline fallback: neither CLI file exists (e.g. marketplace installs).
      // Generate a self-contained node -e script that performs the upgrade.
      const repoUrl = "https://github.com/mksglu/context-mode.git";
      const copyDirs = ["build", "hooks", "skills", "scripts", ".claude-plugin"];
      const copyFiles = ["start.mjs", "server.bundle.mjs", "cli.bundle.mjs", "package.json"];

      // Write inline script to a temp .mjs file — avoids quote-escaping issues
      // across cmd.exe, PowerShell, and bash (node -e '...' breaks on Windows).
      const scriptLines = [
        `import{execFileSync}from"node:child_process";`,
        `import{cpSync,rmSync,existsSync,mkdtempSync}from"node:fs";`,
        `import{join}from"node:path";`,
        `import{tmpdir}from"node:os";`,
        `const P=${JSON.stringify(pluginRoot)};`,
        `const T=mkdtempSync(join(tmpdir(),"ctx-upgrade-"));`,
        `try{`,
        `console.log("- [x] Starting inline upgrade (no CLI found)");`,
        `execFileSync("git",["clone","--depth","1","${repoUrl}",T],{stdio:"inherit"});`,
        `console.log("- [x] Cloned latest source");`,
        `execFileSync("npm",["install"],{cwd:T,stdio:"inherit"});`,
        `execFileSync("npm",["run","build"],{cwd:T,stdio:"inherit"});`,
        `console.log("- [x] Built from source");`,
        ...copyDirs.map(
          (d) =>
            `if(existsSync(join(T,${JSON.stringify(d)})))cpSync(join(T,${JSON.stringify(d)}),join(P,${JSON.stringify(d)}),{recursive:true,force:true});`,
        ),
        ...copyFiles.map(
          (f) =>
            `if(existsSync(join(T,${JSON.stringify(f)})))cpSync(join(T,${JSON.stringify(f)}),join(P,${JSON.stringify(f)}),{force:true});`,
        ),
        `console.log("- [x] Copied build artifacts");`,
        `execFileSync("npm",["install","--production"],{cwd:P,stdio:"inherit"});`,
        `console.log("- [x] Installed production dependencies");`,
        `console.log("## context-mode upgrade complete");`,
        `}catch(e){`,
        `console.error("- [ ] Upgrade failed:",e.message);`,
        `process.exit(1);`,
        `}finally{`,
        `try{rmSync(T,{recursive:true,force:true})}catch{}`,
        `}`,
      ].join("\n");

      // Server writes the temp script file — avoids shell quoting issues entirely
      const tmpScript = resolve(pluginRoot, ".ctx-upgrade-inline.mjs");
      const { writeFileSync: writeTmp } = await import("node:fs");
      writeTmp(tmpScript, scriptLines);
      cmd = `node "${tmpScript}"`;
    }

    const text = [
      "## ctx-upgrade",
      "",
      "Run this command using your shell execution tool:",
      "",
      "```",
      cmd,
      "```",
      "",
      "After the command completes, display results as a markdown checklist:",
      "- `[x]` for success, `[ ]` for failure",
      "- Example format:",
      "  ```",
      "  ## context-mode upgrade",
      "  - [x] Pulled latest from GitHub",
      "  - [x] Built and installed v0.9.24",
      "  - [x] npm global updated",
      "  - [x] Hooks configured",
      "  - [x] Doctor: all checks PASS",
      "  ```",
      "- Tell the user to restart their session to pick up the new version.",
    ].join("\n");

    return trackResponse("ctx_upgrade", {
      content: [{ type: "text" as const, text }],
    });
  },
);

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
    if (_store) _store.close(); // persist DB for --continue sessions
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

  // Log detected MCP client for diagnostics
  try {
    const { detectPlatform, getAdapter } = await import("./adapters/detect.js");
    const clientInfo = server.server.getClientVersion();
    const signal = detectPlatform(clientInfo ?? undefined);
    await getAdapter(signal.platform);
    if (clientInfo) {
      console.error(`MCP client: ${clientInfo.name} v${clientInfo.version} → ${signal.platform}`);
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
