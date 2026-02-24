/**
 * ContentStore — FTS5 BM25-based knowledge base for context-mode.
 *
 * Chunks markdown content by headings (keeping code blocks intact),
 * stores in SQLite FTS5, and retrieves via BM25-ranked search.
 *
 * Use for documentation, API references, and any content where
 * you need EXACT text later — not summaries.
 */
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
export declare class ContentStore {
    #private;
    constructor(dbPath?: string);
    index(options: {
        content?: string;
        path?: string;
        source?: string;
    }): IndexResult;
    /**
     * Index plain-text output (logs, build output, test results) by splitting
     * into fixed-size line groups. Unlike markdown indexing, this does not
     * look for headings — it chunks by line count with overlap.
     */
    indexPlainText(content: string, source: string, linesPerChunk?: number): IndexResult;
    search(query: string, limit?: number, source?: string): SearchResult[];
    listSources(): Array<{
        label: string;
        chunkCount: number;
    }>;
    getDistinctiveTerms(sourceId: number, maxTerms?: number): string[];
    getStats(): StoreStats;
    close(): void;
}
