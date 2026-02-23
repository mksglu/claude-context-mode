/**
 * ContentStore — FTS5 BM25-based knowledge base for context-mode.
 *
 * Chunks markdown content by headings (keeping code blocks intact),
 * stores in SQLite FTS5, and retrieves via BM25-ranked search.
 *
 * Use for documentation, API references, and any content where
 * you need EXACT text later — not summaries.
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface Chunk {
  title: string;
  content: string;
  hasCode: boolean;
}

export interface IndexResult {
  sourceId: number;
  label: string;
  totalChunks: number;
  codeChunks: number;
}

export interface SearchResult {
  title: string;
  content: string;
  source: string;
  rank: number;
  contentType: "code" | "prose";
}

export interface StoreStats {
  sources: number;
  chunks: number;
  codeChunks: number;
}

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "his", "how", "its", "may",
  "new", "now", "old", "see", "way", "who", "did", "get", "got", "let",
  "say", "she", "too", "use", "will", "with", "this", "that", "from",
  "they", "been", "have", "many", "some", "them", "than", "each", "make",
  "like", "just", "over", "such", "take", "into", "year", "your", "good",
  "could", "would", "about", "which", "their", "there", "other", "after",
  "should", "through", "also", "more", "most", "only", "very", "when",
  "what", "then", "these", "those", "being", "does", "done", "both",
  "same", "still", "while", "where", "here", "were", "much",
  // Common in code/changelogs
  "update", "updates", "updated", "deps", "dev", "tests", "test",
  "add", "added", "fix", "fixed", "run", "running", "using",
]);

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function sanitizeQuery(query: string): string {
  const words = query
    .replace(/['"(){}[\]*:^~]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 0 &&
        !["AND", "OR", "NOT", "NEAR"].includes(w.toUpperCase()),
    );

  if (words.length === 0) return '""';
  return words.map((w) => `"${w}"`).join(" ");
}

// ─────────────────────────────────────────────────────────
// ContentStore
// ─────────────────────────────────────────────────────────

export class ContentStore {
  #db: Database.Database;

  constructor(dbPath?: string) {
    const path =
      dbPath ?? join(tmpdir(), `context-mode-${process.pid}.db`);
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = NORMAL");
    this.#initSchema();
  }

  // ── Schema ──

  #initSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        code_chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        tokenize='porter unicode61'
      );
    `);
  }

  // ── Index ──

  index(options: {
    content?: string;
    path?: string;
    source?: string;
  }): IndexResult {
    const { content, path, source } = options;

    if (!content && !path) {
      throw new Error("Either content or path must be provided");
    }

    const text = content ?? readFileSync(path!, "utf-8");
    const label = source ?? path ?? "untitled";
    const chunks = this.#chunkMarkdown(text);

    if (chunks.length === 0) {
      const insertSource = this.#db.prepare(
        "INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?, 0, 0)",
      );
      const info = insertSource.run(label);
      return {
        sourceId: Number(info.lastInsertRowid),
        label,
        totalChunks: 0,
        codeChunks: 0,
      };
    }

    const codeChunks = chunks.filter((c) => c.hasCode).length;

    const insertSource = this.#db.prepare(
      "INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?, ?, ?)",
    );
    const insertChunk = this.#db.prepare(
      "INSERT INTO chunks (title, content, source_id, content_type) VALUES (?, ?, ?, ?)",
    );

    const transaction = this.#db.transaction(() => {
      const info = insertSource.run(label, chunks.length, codeChunks);
      const sourceId = Number(info.lastInsertRowid);

      for (const chunk of chunks) {
        insertChunk.run(
          chunk.title,
          chunk.content,
          sourceId,
          chunk.hasCode ? "code" : "prose",
        );
      }

      return sourceId;
    });

    const sourceId = transaction();

    return {
      sourceId,
      label,
      totalChunks: chunks.length,
      codeChunks,
    };
  }

  // ── Index Plain Text ──

  /**
   * Index plain-text output (logs, build output, test results) by splitting
   * into fixed-size line groups. Unlike markdown indexing, this does not
   * look for headings — it chunks by line count with overlap.
   */
  indexPlainText(
    content: string,
    source: string,
    linesPerChunk: number = 20,
  ): IndexResult {
    if (!content || content.trim().length === 0) {
      const insertSource = this.#db.prepare(
        "INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?, 0, 0)",
      );
      const info = insertSource.run(source);
      return {
        sourceId: Number(info.lastInsertRowid),
        label: source,
        totalChunks: 0,
        codeChunks: 0,
      };
    }

    const chunks = this.#chunkPlainText(content, linesPerChunk);

    const insertSource = this.#db.prepare(
      "INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?, ?, ?)",
    );
    const insertChunk = this.#db.prepare(
      "INSERT INTO chunks (title, content, source_id, content_type) VALUES (?, ?, ?, ?)",
    );

    const transaction = this.#db.transaction(() => {
      const info = insertSource.run(source, chunks.length, 0);
      const sourceId = Number(info.lastInsertRowid);

      for (const chunk of chunks) {
        insertChunk.run(chunk.title, chunk.content, sourceId, "prose");
      }

      return sourceId;
    });

    const sourceId = transaction();

    return {
      sourceId,
      label: source,
      totalChunks: chunks.length,
      codeChunks: 0,
    };
  }

  // ── Search ──

  search(query: string, limit: number = 3): SearchResult[] {
    const sanitized = sanitizeQuery(query);

    const stmt = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        sources.label,
        bm25(chunks, 2.0, 1.0) AS rank
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    const rows = stmt.all(sanitized, limit) as Array<{
      title: string;
      content: string;
      content_type: string;
      label: string;
      rank: number;
    }>;

    return rows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.label,
      rank: r.rank,
      contentType: r.content_type as "code" | "prose",
    }));
  }

  // ── Vocabulary ──

  getDistinctiveTerms(sourceId: number, maxTerms: number = 40): string[] {
    const stats = this.#db
      .prepare("SELECT chunk_count FROM sources WHERE id = ?")
      .get(sourceId) as { chunk_count: number } | undefined;

    if (!stats || stats.chunk_count < 3) return [];

    const totalChunks = stats.chunk_count;
    const minAppearances = 2;
    const maxAppearances = Math.max(3, Math.ceil(totalChunks * 0.4));

    const rows = this.#db
      .prepare("SELECT content FROM chunks WHERE source_id = ?")
      .all(sourceId) as Array<{ content: string }>;

    // Count document frequency (how many sections contain each word)
    const docFreq = new Map<string, number>();

    for (const row of rows) {
      const words = new Set(
        row.content
          .toLowerCase()
          .split(/[^\p{L}\p{N}_-]+/u)
          .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
      );
      for (const word of words) {
        docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
      }
    }

    const filtered = Array.from(docFreq.entries())
      .filter(([, count]) => count >= minAppearances && count <= maxAppearances);

    // Score: IDF (rarity) + length bonus + identifier bonus (underscore/camelCase)
    const scored = filtered.map(([word, count]: [string, number]) => {
      const idf = Math.log(totalChunks / count);
      const lenBonus = Math.min(word.length / 20, 0.5);
      const hasSpecialChars = /[_]/.test(word);
      const isCamelOrLong = word.length >= 12;
      const identifierBonus = hasSpecialChars ? 1.5 : isCamelOrLong ? 0.8 : 0;
      return { word, score: idf + lenBonus + identifierBonus };
    });

    return scored
      .sort((a: { word: string; score: number }, b: { word: string; score: number }) => b.score - a.score)
      .slice(0, maxTerms)
      .map((s: { word: string; score: number }) => s.word);
  }

  // ── Stats ──

  getStats(): StoreStats {
    const sources =
      (
        this.#db.prepare("SELECT COUNT(*) as c FROM sources").get() as {
          c: number;
        }
      )?.c ?? 0;

    const chunks =
      (
        this.#db
          .prepare("SELECT COUNT(*) as c FROM chunks")
          .get() as { c: number }
      )?.c ?? 0;

    const codeChunks =
      (
        this.#db
          .prepare(
            "SELECT COUNT(*) as c FROM chunks WHERE content_type = 'code'",
          )
          .get() as { c: number }
      )?.c ?? 0;

    return { sources, chunks, codeChunks };
  }

  // ── Cleanup ──

  close(): void {
    this.#db.close();
  }

  // ── Chunking ──

  #chunkMarkdown(text: string): Chunk[] {
    const chunks: Chunk[] = [];
    const lines = text.split("\n");
    const headingStack: Array<{ level: number; text: string }> = [];
    let currentContent: string[] = [];
    let currentHeading = "";

    const flush = () => {
      const joined = currentContent.join("\n").trim();
      if (joined.length === 0) return;

      chunks.push({
        title: this.#buildTitle(headingStack, currentHeading),
        content: joined,
        hasCode: currentContent.some((l) => /^`{3,}/.test(l)),
      });
      currentContent = [];
    };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Horizontal rule separator (Context7 uses long dashes)
      if (/^[-_*]{3,}\s*$/.test(line)) {
        flush();
        i++;
        continue;
      }

      // Heading (H1-H4)
      const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        flush();

        const level = headingMatch[1].length;
        const heading = headingMatch[2].trim();

        // Pop deeper levels from stack
        while (
          headingStack.length > 0 &&
          headingStack[headingStack.length - 1].level >= level
        ) {
          headingStack.pop();
        }
        headingStack.push({ level, text: heading });
        currentHeading = heading;

        currentContent.push(line);
        i++;
        continue;
      }

      // Code block — collect entire block as a unit
      const codeMatch = line.match(/^(`{3,})(.*)?$/);
      if (codeMatch) {
        const fence = codeMatch[1];
        const codeLines: string[] = [line];
        i++;

        while (i < lines.length) {
          codeLines.push(lines[i]);
          if (lines[i].startsWith(fence) && lines[i].trim() === fence) {
            i++;
            break;
          }
          i++;
        }

        currentContent.push(...codeLines);
        continue;
      }

      // Regular line
      currentContent.push(line);
      i++;
    }

    // Flush remaining content
    flush();

    return chunks;
  }

  #chunkPlainText(
    text: string,
    linesPerChunk: number,
  ): Array<{ title: string; content: string }> {
    // Try blank-line splitting first for naturally-sectioned output
    const sections = text.split(/\n\s*\n/);
    if (
      sections.length >= 3 &&
      sections.length <= 200 &&
      sections.every((s) => Buffer.byteLength(s) < 5000)
    ) {
      return sections
        .map((section, i) => {
          const trimmed = section.trim();
          const firstLine = trimmed.split("\n")[0].slice(0, 80);
          return {
            title: firstLine || `Section ${i + 1}`,
            content: trimmed,
          };
        })
        .filter((s) => s.content.length > 0);
    }

    const lines = text.split("\n");

    // Small enough for a single chunk
    if (lines.length <= linesPerChunk) {
      return [{ title: "Output", content: text }];
    }

    // Fixed-size line groups with 2-line overlap
    const chunks: Array<{ title: string; content: string }> = [];
    const overlap = 2;
    const step = Math.max(linesPerChunk - overlap, 1);

    for (let i = 0; i < lines.length; i += step) {
      const slice = lines.slice(i, i + linesPerChunk);
      if (slice.length === 0) break;
      const startLine = i + 1;
      const endLine = Math.min(i + slice.length, lines.length);
      const firstLine = slice[0]?.trim().slice(0, 80);
      chunks.push({
        title: firstLine || `Lines ${startLine}-${endLine}`,
        content: slice.join("\n"),
      });
    }

    return chunks;
  }

  #buildTitle(
    headingStack: Array<{ level: number; text: string }>,
    currentHeading: string,
  ): string {
    if (headingStack.length === 0) {
      return currentHeading || "Untitled";
    }
    return headingStack.map((h) => h.text).join(" > ");
  }
}
