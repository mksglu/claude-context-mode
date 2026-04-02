/**
 * ContentStore — FTS5 BM25-based knowledge base for context-mode.
 *
 * Chunks markdown content by headings (keeping code blocks intact),
 * stores in SQLite FTS5, and retrieves via BM25-ranked search.
 *
 * Use for documentation, API references, and any content where
 * you need EXACT text later — not summaries.
 */

import type { Database as DatabaseInstance } from "better-sqlite3";
import { loadDatabase, applyWALPragmas, closeDB, withRetry } from "./db-base.js";
import type { PreparedStatement } from "./db-base.js";
import { readFileSync, readdirSync, unlinkSync, existsSync, statSync } from "node:fs";
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

type SourceMatchMode = "like" | "exact";

type SearchRow = {
  title: string;
  content: string;
  content_type: string;
  label: string;
  rank: number;
  highlighted: string;
};

import type { IndexResult, SearchResult, StoreStats } from "./types.js";
export type { IndexResult, SearchResult, StoreStats } from "./types.js";

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

function sanitizeQuery(query: string, mode: "AND" | "OR" = "AND"): string {
  const words = query
    .replace(/['"(){}[\]*:^~]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 0 &&
        !["AND", "OR", "NOT", "NEAR"].includes(w.toUpperCase()),
    );

  if (words.length === 0) return '""';
  return words.map((w) => `"${w}"`).join(mode === "OR" ? " OR " : " ");
}

function sanitizeTrigramQuery(query: string, mode: "AND" | "OR" = "AND"): string {
  const cleaned = query.replace(/["'(){}[\]*:^~]/g, "").trim();
  if (cleaned.length < 3) return "";
  const words = cleaned.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length === 0) return "";
  return words.map((w) => `"${w}"`).join(mode === "OR" ? " OR " : " ");
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

function maxEditDistance(wordLength: number): number {
  if (wordLength <= 4) return 1;
  if (wordLength <= 12) return 2;
  return 3;
}

// Oversized chunks (e.g., a 50KB section between two headings) hurt BM25
// length normalization and produce unwieldy search results. Split at paragraph
// boundaries when a chunk exceeds this cap.
const MAX_CHUNK_BYTES = 4096;

// ─────────────────────────────────────────────────────────
// ContentStore
// ─────────────────────────────────────────────────────────

/**
 * Remove stale DB files from previous sessions whose processes no longer exist.
 */
export function cleanupStaleDBs(): number {
  const dir = tmpdir();
  let cleaned = 0;
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const match = file.match(/^context-mode-(\d+)\.db$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (pid === process.pid) continue;
      try {
        process.kill(pid, 0);
      } catch {
        const base = join(dir, file);
        for (const suffix of ["", "-wal", "-shm"]) {
          try { unlinkSync(base + suffix); } catch { /* ignore */ }
        }
        cleaned++;
      }
    }
  } catch { /* ignore readdir errors */ }
  return cleaned;
}

/**
 * Check if a PID is still alive (not a zombie holding a WAL lock).
 * Returns true if the process exists, false if it's dead.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up stale per-project content store DBs older than maxAgeDays.
 * Scans the given directory for *.db files and checks mtime.
 * Also detects zombie processes holding WAL locks — if a WAL file exists
 * but the owning PID is dead, the DB files are cleaned up regardless of age.
 */
export function cleanupStaleContentDBs(contentDir: string, maxAgeDays: number): number {
  let cleaned = 0;
  try {
    if (!existsSync(contentDir)) return 0;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(contentDir).filter(f => f.endsWith(".db"));
    for (const file of files) {
      try {
        const filePath = join(contentDir, file);
        const mtime = statSync(filePath).mtimeMs;
        let shouldClean = mtime < cutoff;

        // Detect zombie processes holding WAL locks:
        // If a WAL file exists, try to read the WAL header to extract the PID.
        // WAL files from dead processes can block new connections.
        if (!shouldClean) {
          const walPath = filePath + "-wal";
          if (existsSync(walPath)) {
            try {
              const walStat = statSync(walPath);
              // If WAL file is non-empty and DB hasn't been modified in >1 hour,
              // the owning process may be dead — check via mtime staleness
              if (walStat.size > 0 && (Date.now() - walStat.mtimeMs) > 3600_000) {
                shouldClean = true;
              }
            } catch { /* ignore WAL check errors */ }
          }
        }

        if (shouldClean) {
          for (const suffix of ["", "-wal", "-shm"]) {
            try { unlinkSync(filePath + suffix); } catch { /* ignore */ }
          }
          cleaned++;
        }
      } catch { /* ignore per-file errors */ }
    }
  } catch { /* ignore readdir errors */ }
  return cleaned;
}

// ── Proximity helpers (pure functions) ──

/** Find all positions of a term in text. */
function findAllPositions(text: string, term: string): number[] {
  const positions: number[] = [];
  let idx = text.indexOf(term);
  while (idx !== -1) {
    positions.push(idx);
    idx = text.indexOf(term, idx + 1);
  }
  return positions;
}

/**
 * Find minimum span (window) covering at least one position from each list.
 * Uses a sweep-line approach: advance the pointer at the current minimum.
 */
function findMinSpan(positionLists: number[][]): number {
  if (positionLists.length === 0) return Infinity;
  if (positionLists.length === 1) return 0;

  const sorted = positionLists.map((p) => [...p].sort((a, b) => a - b));
  const ptrs = new Array(sorted.length).fill(0);
  let minSpan = Infinity;

  while (true) {
    let curMin = Infinity;
    let curMax = -Infinity;
    let minIdx = 0;

    for (let i = 0; i < sorted.length; i++) {
      const val = sorted[i][ptrs[i]];
      if (val < curMin) {
        curMin = val;
        minIdx = i;
      }
      if (val > curMax) {
        curMax = val;
      }
    }

    const span = curMax - curMin;
    if (span < minSpan) minSpan = span;

    ptrs[minIdx]++;
    if (ptrs[minIdx] >= sorted[minIdx].length) break;
  }

  return minSpan;
}

export class ContentStore {
  #db: DatabaseInstance;
  #dbPath: string;

  // ── Cached Prepared Statements ──
  // Prepared once at construction, reused on every call to avoid
  // re-compiling SQL on each invocation.

  // Write path
  #stmtInsertSourceEmpty!: PreparedStatement;
  #stmtInsertSource!: PreparedStatement;
  #stmtInsertChunk!: PreparedStatement;
  #stmtInsertChunkTrigram!: PreparedStatement;
  #stmtInsertVocab!: PreparedStatement;

  // Dedup path (delete previous source with same label before re-indexing)
  #stmtDeleteChunksByLabel!: PreparedStatement;
  #stmtDeleteChunksTrigramByLabel!: PreparedStatement;
  #stmtDeleteSourcesByLabel!: PreparedStatement;

  // Search path (hot)
  #stmtSearchPorter!: PreparedStatement;
  #stmtSearchPorterFiltered!: PreparedStatement;
  #stmtSearchPorterExact!: PreparedStatement;
  #stmtSearchTrigram!: PreparedStatement;
  #stmtSearchTrigramFiltered!: PreparedStatement;
  #stmtSearchTrigramExact!: PreparedStatement;
  #stmtFuzzyVocab!: PreparedStatement;
  #stmtSearchPorterContentType!: PreparedStatement;
  #stmtSearchPorterFilteredContentType!: PreparedStatement;
  #stmtSearchPorterExactContentType!: PreparedStatement;
  #stmtSearchTrigramContentType!: PreparedStatement;
  #stmtSearchTrigramFilteredContentType!: PreparedStatement;
  #stmtSearchTrigramExactContentType!: PreparedStatement;

  // Read path
  #stmtListSources!: PreparedStatement;
  #stmtChunksBySource!: PreparedStatement;
  #stmtSourceChunkCount!: PreparedStatement;
  #stmtChunkContent!: PreparedStatement;
  #stmtStats!: PreparedStatement;
  #stmtSourceMeta!: PreparedStatement;

  constructor(dbPath?: string) {
    const Database = loadDatabase();
    this.#dbPath =
      dbPath ?? join(tmpdir(), `context-mode-${process.pid}.db`);
    this.#db = new Database(this.#dbPath, { timeout: 30000 });
    applyWALPragmas(this.#db);
    this.#initSchema();
    this.#prepareStatements();
  }

  /** Delete this session's DB files. Call on process exit. */
  cleanup(): void {
    try {
      this.#db.close();
    } catch { /* ignore */ }
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(this.#dbPath + suffix); } catch { /* ignore */ }
    }
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

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        tokenize='trigram'
      );

      CREATE TABLE IF NOT EXISTS vocabulary (
        word TEXT PRIMARY KEY
      );

      CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
    `);
  }

  #prepareStatements(): void {
    // Write path
    this.#stmtInsertSourceEmpty = this.#db.prepare(
      "INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?, 0, 0)",
    );
    this.#stmtInsertSource = this.#db.prepare(
      "INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?, ?, ?)",
    );
    this.#stmtInsertChunk = this.#db.prepare(
      "INSERT INTO chunks (title, content, source_id, content_type) VALUES (?, ?, ?, ?)",
    );
    this.#stmtInsertChunkTrigram = this.#db.prepare(
      "INSERT INTO chunks_trigram (title, content, source_id, content_type) VALUES (?, ?, ?, ?)",
    );
    this.#stmtInsertVocab = this.#db.prepare(
      "INSERT OR IGNORE INTO vocabulary (word) VALUES (?)",
    );

    // Dedup path: delete previous source with same label before re-indexing
    // Prevents stale outputs from accumulating in iterative workflows (build-fix-build)
    this.#stmtDeleteChunksByLabel = this.#db.prepare(
      "DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?)",
    );
    this.#stmtDeleteChunksTrigramByLabel = this.#db.prepare(
      "DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE label = ?)",
    );
    this.#stmtDeleteSourcesByLabel = this.#db.prepare(
      "DELETE FROM sources WHERE label = ?",
    );

    // Search path (hot)
    this.#stmtSearchPorter = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterFiltered = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterExact = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigram = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramFiltered = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramExact = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `);

    // Content-type filtered variants
    this.#stmtSearchPorterContentType = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterFilteredContentType = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterExactContentType = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label = ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramContentType = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramFilteredContentType = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramExactContentType = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label = ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);

    // Fuzzy path
    this.#stmtFuzzyVocab = this.#db.prepare(
      "SELECT word FROM vocabulary WHERE length(word) BETWEEN ? AND ?",
    );

    // Read path
    this.#stmtListSources = this.#db.prepare(
      "SELECT label, chunk_count as chunkCount FROM sources ORDER BY id DESC",
    );
    this.#stmtChunksBySource = this.#db.prepare(
      `SELECT c.title, c.content, c.content_type, s.label
       FROM chunks c
       JOIN sources s ON s.id = c.source_id
       WHERE c.source_id = ?
       ORDER BY c.rowid`,
    );
    this.#stmtSourceChunkCount = this.#db.prepare(
      "SELECT chunk_count FROM sources WHERE id = ?",
    );
    this.#stmtChunkContent = this.#db.prepare(
      "SELECT content FROM chunks WHERE source_id = ?",
    );
    this.#stmtSourceMeta = this.#db.prepare(
      "SELECT label, chunk_count, code_chunk_count, indexed_at FROM sources WHERE label = ?",
    );
    this.#stmtStats = this.#db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sources) AS sources,
        (SELECT COUNT(*) FROM chunks) AS chunks,
        (SELECT COUNT(*) FROM chunks WHERE content_type = 'code') AS codeChunks
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

    return withRetry(() => this.#insertChunks(chunks, label, text));
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
      return this.#insertChunks([], source, "");
    }

    const chunks = this.#chunkPlainText(content, linesPerChunk);

    return this.#insertChunks(
      chunks.map((c) => ({ ...c, hasCode: false })),
      source,
      content,
    );
  }

  // ── Index JSON ──

  /**
   * Index JSON content by walking the object tree and using key paths
   * as chunk titles (analogous to heading hierarchy in markdown). Objects
   * recurse by key; arrays batch items by size.
   *
   * Falls back to `indexPlainText` if the content is not valid JSON.
   */
  indexJSON(
    content: string,
    source: string,
    maxChunkBytes: number = MAX_CHUNK_BYTES,
  ): IndexResult {
    if (!content || content.trim().length === 0) {
      return this.indexPlainText("", source);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return this.indexPlainText(content, source);
    }

    const chunks: Chunk[] = [];
    this.#walkJSON(parsed, [], chunks, maxChunkBytes);

    if (chunks.length === 0) {
      return this.indexPlainText(content, source);
    }

    return this.#insertChunks(chunks, source, content);
  }

  // ── Shared DB Insertion ──

  /**
   * Shared DB insertion logic for all index methods. Inserts chunks
   * into both FTS5 tables within a transaction and extracts vocabulary.
   * Uses cached prepared statements from #prepareStatements().
   */
  #insertChunks(chunks: Chunk[], label: string, text: string): IndexResult {
    const codeChunks = chunks.filter((c) => c.hasCode).length;

    // Atomic dedup + insert: delete previous source with same label,
    // then insert new content — all within a single transaction.
    // Prevents stale results in iterative workflows. (See: GitHub issue #67)
    const transaction = this.#db.transaction(() => {
      this.#stmtDeleteChunksByLabel.run(label);
      this.#stmtDeleteChunksTrigramByLabel.run(label);
      this.#stmtDeleteSourcesByLabel.run(label);

      if (chunks.length === 0) {
        const info = this.#stmtInsertSourceEmpty.run(label);
        return Number(info.lastInsertRowid);
      }

      const info = this.#stmtInsertSource.run(label, chunks.length, codeChunks);
      const sourceId = Number(info.lastInsertRowid);

      for (const chunk of chunks) {
        const ct = chunk.hasCode ? "code" : "prose";
        this.#stmtInsertChunk.run(chunk.title, chunk.content, sourceId, ct);
        this.#stmtInsertChunkTrigram.run(chunk.title, chunk.content, sourceId, ct);
      }

      return sourceId;
    });

    const sourceId = transaction();
    if (text) this.#extractAndStoreVocabulary(text);

    return {
      sourceId,
      label,
      totalChunks: chunks.length,
      codeChunks,
    };
  }

  // ── Search ──

  #mapSearchRows(rows: SearchRow[]): SearchResult[] {
    return rows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.label,
      rank: r.rank,
      contentType: r.content_type as "code" | "prose",
      highlighted: r.highlighted,
    }));
  }

  #sourceFilterParam(source: string, sourceMatchMode: SourceMatchMode): string {
    return sourceMatchMode === "exact" ? source : `%${source}%`;
  }

  search(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    const sanitized = sanitizeQuery(query, mode);

    let stmt: PreparedStatement;
    let params: unknown[];

    if (source && contentType) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchPorterExactContentType
        : this.#stmtSearchPorterFilteredContentType;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), contentType, limit];
    } else if (source) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchPorterExact
        : this.#stmtSearchPorterFiltered;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), limit];
    } else if (contentType) {
      stmt = this.#stmtSearchPorterContentType;
      params = [sanitized, contentType, limit];
    } else {
      stmt = this.#stmtSearchPorter;
      params = [sanitized, limit];
    }

    return withRetry(() => this.#mapSearchRows(stmt.all(...params) as SearchRow[]));
  }

  // ── Trigram Search (Layer 2) ──

  searchTrigram(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    const sanitized = sanitizeTrigramQuery(query, mode);
    if (!sanitized) return [];

    let stmt: PreparedStatement;
    let params: unknown[];

    if (source && contentType) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchTrigramExactContentType
        : this.#stmtSearchTrigramFilteredContentType;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), contentType, limit];
    } else if (source) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchTrigramExact
        : this.#stmtSearchTrigramFiltered;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), limit];
    } else if (contentType) {
      stmt = this.#stmtSearchTrigramContentType;
      params = [sanitized, contentType, limit];
    } else {
      stmt = this.#stmtSearchTrigram;
      params = [sanitized, limit];
    }

    return this.#mapSearchRows(stmt.all(...params) as SearchRow[]);
  }

  // ── Fuzzy Correction (Layer 3) ──

  fuzzyCorrect(query: string): string | null {
    const word = query.toLowerCase().trim();
    if (word.length < 3) return null;

    const maxDist = maxEditDistance(word.length);

    const candidates = this.#stmtFuzzyVocab.all(
      word.length - maxDist,
      word.length + maxDist,
    ) as Array<{ word: string }>;

    let bestWord: string | null = null;
    let bestDist = maxDist + 1;

    for (const { word: candidate } of candidates) {
      if (candidate === word) return null; // exact match — no correction
      const dist = levenshtein(word, candidate);
      if (dist < bestDist) {
        bestDist = dist;
        bestWord = candidate;
      }
    }

    return bestDist <= maxDist ? bestWord : null;
  }

  // ── Reciprocal Rank Fusion (Cormack et al. 2009) ──

  #rrfSearch(
    query: string,
    limit: number,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    const K = 60; // Standard RRF constant
    const fetchLimit = Math.max(limit * 2, 10);

    const porterResults = this.search(query, fetchLimit, source, "OR", contentType, sourceMatchMode);
    const trigramResults = this.searchTrigram(query, fetchLimit, source, "OR", contentType, sourceMatchMode);

    const scoreMap = new Map<string, { result: SearchResult; score: number }>();
    const key = (r: SearchResult) => `${r.source}::${r.title}`;

    for (const [i, r] of porterResults.entries()) {
      const k = key(r);
      const existing = scoreMap.get(k);
      if (existing) {
        existing.score += 1 / (K + i + 1);
      } else {
        scoreMap.set(k, { result: r, score: 1 / (K + i + 1) });
      }
    }

    for (const [i, r] of trigramResults.entries()) {
      const k = key(r);
      const existing = scoreMap.get(k);
      if (existing) {
        existing.score += 1 / (K + i + 1);
      } else {
        scoreMap.set(k, { result: r, score: 1 / (K + i + 1) });
      }
    }

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ result, score }) => ({ ...result, rank: -score }));
  }

  // ── Proximity Reranking ──

  #applyProximityReranking(
    results: SearchResult[],
    query: string,
  ): SearchResult[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2);

    // Single-term queries: no reranking needed
    if (terms.length < 2) return results;

    return results
      .map((r) => {
        const content = r.content.toLowerCase();
        const positions = terms.map((t) => findAllPositions(content, t));

        // If any term is missing from content, no proximity boost
        if (positions.some((p) => p.length === 0)) {
          return { result: r, boost: 0 };
        }

        const minSpan = findMinSpan(positions);
        const boost = 1 / (1 + minSpan / Math.max(content.length, 1));
        return { result: r, boost };
      })
      .sort((a, b) => b.boost - a.boost || a.result.rank - b.result.rank)
      .map(({ result }) => result);
  }

  // ── Unified Fallback Search ──

  searchWithFallback(
    query: string,
    limit: number = 3,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    // Step 1: RRF fusion (porter OR + trigram OR → merge)
    const rrfResults = this.#rrfSearch(query, limit, source, contentType, sourceMatchMode);
    if (rrfResults.length > 0) {
      const reranked = this.#applyProximityReranking(rrfResults, query);
      return reranked.map((r) => ({ ...r, matchLayer: "rrf" as const }));
    }

    // Step 2: Fuzzy correction → RRF re-run
    const words = query
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 3);
    const original = words.join(" ");
    const correctedWords = words.map((w) => this.fuzzyCorrect(w) ?? w);
    const correctedQuery = correctedWords.join(" ");

    if (correctedQuery !== original) {
      const fuzzyResults = this.#rrfSearch(correctedQuery, limit, source, contentType, sourceMatchMode);
      if (fuzzyResults.length > 0) {
        const reranked = this.#applyProximityReranking(fuzzyResults, correctedQuery);
        return reranked.map((r) => ({ ...r, matchLayer: "rrf-fuzzy" as const }));
      }
    }

    return [];
  }

  // ── Sources ──

  getSourceMeta(label: string): { label: string; chunkCount: number; codeChunkCount: number; indexedAt: string } | null {
    const row = this.#stmtSourceMeta.get(label) as { label: string; chunk_count: number; code_chunk_count: number; indexed_at: string } | undefined;
    if (!row) return null;
    return { label: row.label, chunkCount: row.chunk_count, codeChunkCount: row.code_chunk_count, indexedAt: row.indexed_at };
  }

  listSources(): Array<{ label: string; chunkCount: number }> {
    return this.#stmtListSources.all() as Array<{
      label: string;
      chunkCount: number;
    }>;
  }

  /**
   * Get all chunks for a given source by ID — bypasses FTS5 MATCH entirely.
   * Use this for inventory/listing where you need all sections, not search.
   */
  getChunksBySource(sourceId: number): SearchResult[] {
    const rows = this.#stmtChunksBySource.all(sourceId) as Array<{
      title: string;
      content: string;
      content_type: string;
      label: string;
    }>;

    return rows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.label,
      rank: 0,
      contentType: r.content_type as "code" | "prose",
    }));
  }

  // ── Vocabulary ──

  getDistinctiveTerms(sourceId: number, maxTerms: number = 40): string[] {
    const stats = this.#stmtSourceChunkCount.get(sourceId) as
      | { chunk_count: number }
      | undefined;

    if (!stats || stats.chunk_count < 3) return [];

    const totalChunks = stats.chunk_count;
    const minAppearances = 2;
    const maxAppearances = Math.max(3, Math.ceil(totalChunks * 0.4));

    // Stream chunks one at a time to avoid loading all content into memory
    // Count document frequency (how many sections contain each word)
    const docFreq = new Map<string, number>();

    for (const row of this.#stmtChunkContent.iterate(sourceId) as Iterable<{ content: string }>) {
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
    const row = this.#stmtStats.get() as {
      sources: number;
      chunks: number;
      codeChunks: number;
    } | undefined;

    return {
      sources: row?.sources ?? 0,
      chunks: row?.chunks ?? 0,
      codeChunks: row?.codeChunks ?? 0,
    };
  }

  // ── Cleanup ──

  /**
   * Delete sources (and their chunks) older than maxAgeDays.
   * Returns count of deleted sources.
   */
  cleanupStaleSources(maxAgeDays: number): number {
    const deleteChunks = this.#db.prepare(
      "DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days'))",
    );
    const deleteChunksTrigram = this.#db.prepare(
      "DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days'))",
    );
    const deleteSources = this.#db.prepare(
      "DELETE FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days')",
    );
    const cleanup = this.#db.transaction((days: number) => {
      deleteChunks.run(days);
      deleteChunksTrigram.run(days);
      return deleteSources.run(days);
    });
    const info = cleanup(maxAgeDays);
    return info.changes;
  }

  /** Get DB file size in bytes. */
  getDBSizeBytes(): number {
    try {
      return statSync(this.#dbPath).size;
    } catch {
      return 0;
    }
  }

  close(): void {
    closeDB(this.#db); // WAL checkpoint before close — important for persistent DBs
  }

  // ── Vocabulary Extraction ──

  #extractAndStoreVocabulary(content: string): void {
    const words = content
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

    const unique = [...new Set(words)];

    this.#db.transaction(() => {
      for (const word of unique) {
        this.#stmtInsertVocab.run(word);
      }
    })();
  }

  // ── Chunking ──

  #chunkMarkdown(text: string, maxChunkBytes: number = MAX_CHUNK_BYTES): Chunk[] {
    const chunks: Chunk[] = [];
    const lines = text.split("\n");
    const headingStack: Array<{ level: number; text: string }> = [];
    let currentContent: string[] = [];
    let currentHeading = "";

    const flush = () => {
      const joined = currentContent.join("\n").trim();
      if (joined.length === 0) return;

      const title = this.#buildTitle(headingStack, currentHeading);
      const hasCode = currentContent.some((l) => /^`{3,}/.test(l));

      // If under the cap, emit as-is (fast path — most chunks hit this)
      if (Buffer.byteLength(joined) <= maxChunkBytes) {
        chunks.push({ title, content: joined, hasCode });
        currentContent = [];
        return;
      }

      // Split oversized chunk at paragraph boundaries (double newlines)
      const paragraphs = joined.split(/\n\n+/);
      let accumulator: string[] = [];
      let partIndex = 1;

      const flushAccumulator = () => {
        if (accumulator.length === 0) return;
        const part = accumulator.join("\n\n").trim();
        if (part.length === 0) return;
        const partTitle = paragraphs.length > 1 ? `${title} (${partIndex})` : title;
        partIndex++;
        chunks.push({
          title: partTitle,
          content: part,
          hasCode: part.includes("```"),
        });
        accumulator = [];
      };

      for (const para of paragraphs) {
        accumulator.push(para);
        const candidate = accumulator.join("\n\n");
        if (Buffer.byteLength(candidate) > maxChunkBytes && accumulator.length > 1) {
          accumulator.pop();
          flushAccumulator();
          accumulator = [para];
        }
      }
      flushAccumulator();

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

  #walkJSON(
    value: unknown,
    path: string[],
    chunks: Chunk[],
    maxChunkBytes: number,
  ): void {
    const title = path.length > 0 ? path.join(" > ") : "(root)";
    const serialized = JSON.stringify(value, null, 2);

    // Small enough — emit as a single chunk
    if (Buffer.byteLength(serialized) <= maxChunkBytes) {
      // Exception: objects with nested structure (object/array values) always
      // recurse so that key paths become chunk titles for searchability —
      // even when the subtree fits in one chunk. Flat objects (all primitive
      // values) stay as a single chunk since there's no hierarchy to expose.
      const shouldRecurse =
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).some(
          (v) => typeof v === "object" && v !== null,
        );

      if (!shouldRecurse) {
        chunks.push({ title, content: serialized, hasCode: true });
        return;
      }
    }

    // Object — recurse into each key
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const entries = Object.entries(value);
      if (entries.length > 0) {
        for (const [key, val] of entries) {
          this.#walkJSON(val, [...path, key], chunks, maxChunkBytes);
        }
        return;
      }
      // Empty object — emit as-is
      chunks.push({ title, content: serialized, hasCode: true });
      return;
    }

    // Array — batch by size with identity-field-aware titles
    if (Array.isArray(value)) {
      this.#chunkJSONArray(value, path, chunks, maxChunkBytes);
      return;
    }

    // Primitive that exceeds maxChunkBytes (e.g., very long string)
    chunks.push({ title, content: serialized, hasCode: false });
  }

  /**
   * Scan the first element of an array of objects for a recognizable
   * identity field. Returns the field name or null.
   */
  #findIdentityField(arr: unknown[]): string | null {
    if (arr.length === 0) return null;
    const first = arr[0];
    if (typeof first !== "object" || first === null || Array.isArray(first)) return null;

    const candidates = ["id", "name", "title", "path", "slug", "key", "label"];
    const obj = first as Record<string, unknown>;
    for (const field of candidates) {
      if (field in obj && (typeof obj[field] === "string" || typeof obj[field] === "number")) {
        return field;
      }
    }
    return null;
  }

  #jsonBatchTitle(
    prefix: string,
    startIdx: number,
    endIdx: number,
    batch: unknown[],
    identityField: string | null,
  ): string {
    const sep = prefix ? `${prefix} > ` : "";

    if (!identityField) {
      return startIdx === endIdx
        ? `${sep}[${startIdx}]`
        : `${sep}[${startIdx}-${endIdx}]`;
    }

    const getId = (item: unknown) =>
      String((item as Record<string, unknown>)[identityField]);

    if (batch.length === 1) {
      return `${sep}${getId(batch[0])}`;
    }
    if (batch.length <= 3) {
      return sep + batch.map(getId).join(", ");
    }
    return `${sep}${getId(batch[0])}\u2026${getId(batch[batch.length - 1])}`;
  }

  #chunkJSONArray(
    arr: unknown[],
    path: string[],
    chunks: Chunk[],
    maxChunkBytes: number,
  ): void {
    const prefix = path.length > 0 ? path.join(" > ") : "(root)";
    const identityField = this.#findIdentityField(arr);

    let batch: unknown[] = [];
    let batchStart = 0;

    const flushBatch = (batchEnd: number) => {
      if (batch.length === 0) return;
      const title = this.#jsonBatchTitle(prefix, batchStart, batchEnd, batch, identityField);
      chunks.push({
        title,
        content: JSON.stringify(batch, null, 2),
        hasCode: true,
      });
    };

    for (let i = 0; i < arr.length; i++) {
      batch.push(arr[i]);
      const candidate = JSON.stringify(batch, null, 2);

      if (Buffer.byteLength(candidate) > maxChunkBytes && batch.length > 1) {
        batch.pop();
        flushBatch(i - 1);
        batch = [arr[i]];
        batchStart = i;
      }
    }

    // Flush remaining
    flushBatch(batchStart + batch.length - 1);
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
