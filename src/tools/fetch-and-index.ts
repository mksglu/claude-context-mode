/**
 * ctx_fetch_and_index — Fetch URL, convert HTML to markdown, index into FTS5.
 *
 * Content is fetched inside a sandboxed subprocess (so network I/O never
 * enters context).  The subprocess writes content to a temp file to bypass
 * executor stdout truncation, and emits a Content-Type marker on stdout
 * so the handler can route to the appropriate indexing strategy.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PolyglotExecutor } from "../executor.js";
import type { ContentStore, IndexResult } from "../store.js";
import type { ToolResult } from "../server/session-stats.js";
import { errorMessage } from "./tool-utils.js";

export interface ToolDeps {
  trackResponse: (toolName: string, response: ToolResult) => ToolResult;
  trackIndexed: (bytes: number) => void;
  getStore: () => ContentStore;
  executor: PolyglotExecutor;
}

// Turndown path resolution (external dep, like better-sqlite3)
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

export function registerFetchAndIndexTool(server: McpServer, deps: ToolDeps): void {
  const { trackResponse, trackIndexed, getStore, executor } = deps;

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
      }),
    },
    async ({ url, source }) => {
      // Generate a unique temp file path for the subprocess to write fetched content.
      // This bypasses the executor's 100KB stdout truncation — content goes file->handler directly.
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

        // Read full content from temp file (bypasses smartTruncate)
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
          ? markdown.slice(0, PREVIEW_LIMIT) + "\n\n\u2026[truncated \u2014 use search() for full content]"
          : markdown;
        const totalKB = (Buffer.byteLength(markdown) / 1024).toFixed(1);

        const text = [
          `Fetched and indexed **${indexed.totalChunks} sections** (${totalKB}KB) from: ${indexed.label}`,
          `Full content indexed in sandbox \u2014 use search(queries: [...], source: "${indexed.label}") for specific lookups.`,
          "",
          "---",
          "",
          preview,
        ].join("\n");

        return trackResponse("ctx_fetch_and_index", {
          content: [{ type: "text" as const, text }],
        });
      } catch (err: unknown) {
        const message = errorMessage(err);
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
}
