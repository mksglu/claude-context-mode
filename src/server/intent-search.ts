/**
 * intent-search — Intent-driven search on execution output.
 *
 * When an execute-type tool has `intent` set and output is large enough,
 * this indexes the output into the persistent FTS5 store and returns
 * search results instead of raw output.
 */
import type { ContentStore } from "../store.js";
import type { ToolResult } from "./session-stats.js";

/** Threshold in bytes (~80-100 lines) above which intent search is triggered. */
export const INTENT_SEARCH_THRESHOLD = 5_000;

/**
 * Index stdout output and return a success response with indexing stats.
 * Used by execute-type tools to capture large command outputs.
 *
 * @param stdout - The command output to index
 * @param source - Label for the indexed content (e.g., "npm test", "pytest")
 * @param getStore - Factory function to get the ContentStore singleton
 * @param trackIndexed - Callback to record indexed bytes in session stats
 * @returns ToolResult with indexing summary
 */
export function indexStdout(
  stdout: string,
  source: string,
  getStore: () => ContentStore,
  trackIndexed: (bytes: number) => void,
): ToolResult {
  trackIndexed(Buffer.byteLength(stdout));
  const store = getStore();
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

/**
 * Perform intent-driven search on execution output.
 *
 * Indexes the stdout output into the FTS5 store and returns search results
 * matching the intent query instead of raw output. This keeps large outputs
 * out of the context window while still making them queryable.
 *
 * @param stdout - The command output to index and search
 * @param intent - The search query to match against indexed content
 * @param source - Label for the indexed content
 * @param getStore - Factory function to get the ContentStore singleton
 * @param trackIndexed - Callback to record indexed bytes in session stats
 * @param maxResults - Maximum number of search results to return (default: 5)
 * @returns Formatted search results with previews
 */
export function intentSearch(
  stdout: string,
  intent: string,
  source: string,
  getStore: () => ContentStore,
  trackIndexed: (bytes: number) => void,
  maxResults: number = 5,
): string {
  const totalLines = stdout.split("\n").length;
  const totalBytes = Buffer.byteLength(stdout);

  // Index into the PERSISTENT store so user can search() later
  const persistent = getStore();
  const indexed = persistent.indexPlainText(stdout, source);

  // Search the persistent store directly (porter -> trigram -> fuzzy)
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

/**
 * Coerce a value to an array, handling double-serialization.
 * If the value is a JSON string that parses to an array, return the parsed array.
 * Otherwise return the value as-is (let Zod handle validation errors).
 *
 * Used by ctx_search and ctx_batch_execute to handle model responses that
 * double-serialize the queries array.
 *
 * @param val - The value to coerce (typically from a Zod preprocess step)
 * @returns The coerced value (array if successful JSON parse, otherwise original)
 */
export function coerceJsonArray(val: unknown): unknown {
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not valid JSON, let zod handle the error
    }
  }
  return val;
}

/**
 * Coerce commands array: handles double-serialization AND the case where
 * the model passes plain command strings instead of {label, command} objects.
 *
 * Used by ctx_batch_execute to normalize model input into the expected
 * {label: string, command: string}[] format.
 *
 * @param val - The value to coerce
 * @returns Normalized array of {label, command} objects
 */
export function coerceCommandsArray(val: unknown): unknown {
  const arr = coerceJsonArray(val);
  if (Array.isArray(arr)) {
    return arr.map((item, i) =>
      typeof item === "string"
        ? { label: `cmd_${i + 1}`, command: item }
        : item
    );
  }
  return arr;
}
