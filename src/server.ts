#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PolyglotExecutor } from "./executor.js";
import { ContentStore, type SearchResult } from "./store.js";
import {
  detectRuntimes,
  getRuntimeSummary,
  getAvailableLanguages,
  hasBunRuntime,
} from "./runtime.js";

const VERSION = "0.5.1";
const runtimes = detectRuntimes();
const available = getAvailableLanguages(runtimes);
const server = new McpServer({
  name: "context-mode",
  version: VERSION,
});

const executor = new PolyglotExecutor({ runtimes });

// Lazy singleton — no DB overhead unless index/search is used
let _store: ContentStore | null = null;
function getStore(): ContentStore {
  if (!_store) _store = new ContentStore();
  return _store;
}

// Build description dynamically based on detected runtimes
const langList = available.join(", ");
const bunNote = hasBunRuntime()
  ? " (Bun detected — JS/TS runs 3-5x faster)"
  : "";

// ─────────────────────────────────────────────────────────
// Tool: execute
// ─────────────────────────────────────────────────────────

server.registerTool(
  "execute",
  {
    title: "Execute Code",
    description: `Execute code in a sandboxed subprocess. Only stdout enters context — raw data stays in the subprocess. Use instead of bash/cat when output would exceed 20 lines.${bunNote} Available: ${langList}.`,
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
        ])
        .describe("Runtime language"),
      code: z
        .string()
        .describe(
          "Source code to execute. Use console.log (JS/TS), print (Python/Ruby/Perl/R), echo (Shell), echo (PHP), or fmt.Println (Go) to output a summary to context.",
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
          "indexes output into knowledge base and returns section titles + previews — not full content. " +
          "Use search() to retrieve specific sections. Example: 'failing tests', 'HTTP 500 errors'.",
        ),
    }),
  },
  async ({ language, code, timeout, intent }) => {
    try {
      const result = await executor.execute({ language, code, timeout });

      if (result.timedOut) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Execution timed out after ${timeout}ms\n\nPartial stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`,
            },
          ],
          isError: true,
        };
      }

      if (result.exitCode !== 0) {
        const output = `Exit code: ${result.exitCode}\n\nstdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`;
        if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
          return {
            content: [
              { type: "text" as const, text: intentSearch(output, intent, `execute:${language}:error`) },
            ],
            isError: true,
          };
        }
        return {
          content: [
            { type: "text" as const, text: output },
          ],
          isError: true,
        };
      }

      const stdout = result.stdout || "(no output)";

      // Intent-driven search: if intent provided and output is large enough
      if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
        return {
          content: [
            { type: "text" as const, text: intentSearch(stdout, intent, `execute:${language}`) },
          ],
        };
      }

      return {
        content: [
          { type: "text" as const, text: stdout },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text" as const, text: `Runtime error: ${message}` },
        ],
        isError: true,
      };
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
  const indexed = store.index({ content: stdout, source });
  return {
    content: [
      {
        type: "text" as const,
        text: `Indexed ${indexed.totalChunks} sections (${indexed.codeChunks} with code) from: ${indexed.label}\nUse search() to query this content.`,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────
// Helper: intent-driven search on execution output
// ─────────────────────────────────────────────────────────

const INTENT_SEARCH_THRESHOLD = 5_000; // bytes — ~80-100 lines

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

  // Search with an ephemeral store to find matching section titles
  const ephemeral = new ContentStore(":memory:");
  try {
    ephemeral.indexPlainText(stdout, source);
    let results = ephemeral.search(intent, maxResults);

    // Relaxed search: try individual words (OR semantics)
    if (results.length === 0) {
      const words = intent.trim().split(/\s+/).filter(w => w.length > 2);
      const relaxed: SearchResult[] = [];
      for (const word of words) {
        const wordResults = ephemeral.search(word, 3);
        for (const r of wordResults) {
          if (!relaxed.some(existing => existing.title === r.title)) {
            relaxed.push(r);
          }
        }
        if (relaxed.length >= maxResults) break;
      }
      results = relaxed.slice(0, maxResults);
    }

    if (results.length === 0) {
      return (
        `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.\n` +
        `No sections matched intent "${intent}" in ${totalLines}-line output (${(totalBytes / 1024).toFixed(1)}KB).\n` +
        `Use search() to explore the indexed content.`
      );
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

    lines.push("");
    lines.push("Use search() to retrieve full content of any section.");

    return lines.join("\n");
  } finally {
    ephemeral.close();
  }
}

// ─────────────────────────────────────────────────────────
// Tool: execute_file
// ─────────────────────────────────────────────────────────

server.registerTool(
  "execute_file",
  {
    title: "Execute File Processing",
    description:
      "Read a file and process it without loading contents into context. The file is read into a FILE_CONTENT variable inside the sandbox. Only your printed summary enters context.",
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
        ])
        .describe("Runtime language"),
      code: z
        .string()
        .describe(
          "Code to process FILE_CONTENT. Print summary via console.log/print/echo.",
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
    try {
      const result = await executor.executeFile({
        path,
        language,
        code,
        timeout,
      });

      if (result.timedOut) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Timed out processing ${path} after ${timeout}ms`,
            },
          ],
          isError: true,
        };
      }

      if (result.exitCode !== 0) {
        const output = `Error processing ${path} (exit ${result.exitCode}):\n${result.stderr || result.stdout}`;
        if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
          return {
            content: [
              { type: "text" as const, text: intentSearch(output, intent, `file:${path}:error`) },
            ],
            isError: true,
          };
        }
        return {
          content: [
            { type: "text" as const, text: output },
          ],
          isError: true,
        };
      }

      const stdout = result.stdout || "(no output)";

      if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
        return {
          content: [
            { type: "text" as const, text: intentSearch(stdout, intent, `file:${path}`) },
          ],
        };
      }

      return {
        content: [
          { type: "text" as const, text: stdout },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text" as const, text: `Runtime error: ${message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: index
// ─────────────────────────────────────────────────────────

server.registerTool(
  "index",
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
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: Either content or path must be provided",
          },
        ],
        isError: true,
      };
    }

    try {
      const store = getStore();
      const result = store.index({ content, path, source });

      return {
        content: [
          {
            type: "text" as const,
            text: `Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from: ${result.label}\nUse search() to query this content.`,
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text" as const, text: `Index error: ${message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: search
// ─────────────────────────────────────────────────────────

server.registerTool(
  "search",
  {
    title: "Search Indexed Content",
    description:
      "Search previously indexed content using BM25 full-text search. " +
      "Returns the top matching chunks with heading context and full content. " +
      "Use after 'index' to retrieve specific documentation sections, code examples, or API details on demand.\n\n" +
      "WHEN TO USE:\n" +
      "- Find specific code examples ('useEffect cleanup pattern')\n" +
      "- Look up API signatures ('Supabase RLS policy syntax')\n" +
      "- Get configuration details ('Tailwind responsive breakpoints')\n" +
      "- Find migration steps ('App Router data fetching')\n\n" +
      "Returns exact content — not summaries. Each result includes heading hierarchy and full section text.",
    inputSchema: z.object({
      query: z.string().describe("Natural language search query"),
      limit: z
        .number()
        .optional()
        .default(3)
        .describe("Maximum results to return (default: 3)"),
    }),
  },
  async ({ query, limit }) => {
    try {
      const store = getStore();
      const results = store.search(query, limit);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No results found for: "${query}". Make sure content has been indexed first.`,
            },
          ],
        };
      }

      const formatted = results
        .map((r, i) => {
          const header = `--- Result ${i + 1} [${r.source}] (${r.contentType}) ---`;
          const heading = `## ${r.title}`;
          return `${header}\n${heading}\n\n${r.content}`;
        })
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text: formatted }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text" as const, text: `Search error: ${message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: fetch_and_index
// ─────────────────────────────────────────────────────────

const HTML_TO_MARKDOWN_CODE = `
const url = process.argv[1];
if (!url) { console.error("No URL provided"); process.exit(1); }

async function main() {
  const resp = await fetch(url);
  if (!resp.ok) { console.error("HTTP " + resp.status); process.exit(1); }

  let html = await resp.text();

  // Strip script, style, nav, header, footer tags with content
  html = html.replace(/<script[^>]*>[\\s\\S]*?<\\/script>/gi, "");
  html = html.replace(/<style[^>]*>[\\s\\S]*?<\\/style>/gi, "");
  html = html.replace(/<nav[^>]*>[\\s\\S]*?<\\/nav>/gi, "");
  html = html.replace(/<header[^>]*>[\\s\\S]*?<\\/header>/gi, "");
  html = html.replace(/<footer[^>]*>[\\s\\S]*?<\\/footer>/gi, "");

  // Convert headings to markdown
  html = html.replace(/<h1[^>]*>(.*?)<\\/h1>/gi, "\\n# $1\\n");
  html = html.replace(/<h2[^>]*>(.*?)<\\/h2>/gi, "\\n## $1\\n");
  html = html.replace(/<h3[^>]*>(.*?)<\\/h3>/gi, "\\n### $1\\n");
  html = html.replace(/<h4[^>]*>(.*?)<\\/h4>/gi, "\\n#### $1\\n");

  // Convert code blocks
  html = html.replace(/<pre[^>]*><code[^>]*class="[^"]*language-(\\w+)"[^>]*>([\\s\\S]*?)<\\/code><\\/pre>/gi,
    (_, lang, code) => "\\n\\\`\\\`\\\`" + lang + "\\n" + decodeEntities(code) + "\\n\\\`\\\`\\\`\\n");
  html = html.replace(/<pre[^>]*><code[^>]*>([\\s\\S]*?)<\\/code><\\/pre>/gi,
    (_, code) => "\\n\\\`\\\`\\\`\\n" + decodeEntities(code) + "\\n\\\`\\\`\\\`\\n");
  html = html.replace(/<code[^>]*>([^<]*)<\\/code>/gi, "\\\`$1\\\`");

  // Convert links
  html = html.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\\/a>/gi, "[$2]($1)");

  // Convert lists
  html = html.replace(/<li[^>]*>(.*?)<\\/li>/gi, "- $1\\n");

  // Convert paragraphs and line breaks
  html = html.replace(/<p[^>]*>(.*?)<\\/p>/gi, "\\n$1\\n");
  html = html.replace(/<br\\s*\\/?>/gi, "\\n");
  html = html.replace(/<hr\\s*\\/?>/gi, "\\n---\\n");

  // Strip remaining HTML tags
  html = html.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  html = decodeEntities(html);

  // Clean up whitespace
  html = html.replace(/\\n{3,}/g, "\\n\\n").trim();

  console.log(html);
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
}

main();
`;

server.registerTool(
  "fetch_and_index",
  {
    title: "Fetch & Index URL",
    description:
      "Fetches URL content, converts HTML to markdown, and indexes into the searchable knowledge base. " +
      "Raw content never enters context — only a brief confirmation is returned.\n\n" +
      "Use INSTEAD of WebFetch/Context7 when you need to reference web documentation later via search.\n\n" +
      "After fetching, use 'search' to retrieve specific sections on-demand.",
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
    try {
      // Execute fetch inside subprocess — raw HTML never enters context
      const fetchCode = `process.argv[1] = ${JSON.stringify(url)};\n${HTML_TO_MARKDOWN_CODE}`;
      const result = await executor.execute({
        language: "javascript",
        code: fetchCode,
        timeout: 30_000,
      });

      if (result.exitCode !== 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to fetch ${url}: ${result.stderr || result.stdout}`,
            },
          ],
          isError: true,
        };
      }

      if (!result.stdout || result.stdout.trim().length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Fetched ${url} but got empty content after HTML conversion`,
            },
          ],
          isError: true,
        };
      }

      // Index the markdown into FTS5
      return indexStdout(result.stdout, source ?? url);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text" as const, text: `Fetch error: ${message}` },
        ],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────
// Server startup
// ─────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
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
