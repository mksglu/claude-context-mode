/**
 * Cache-key / storage-label composition for ctx_fetch_and_index.
 *
 * Two distinct URLs that share a user-supplied `source` label MUST NOT collide
 * in the cache (or in FTS5 storage, since indexing dedups by label). Compose
 * `${source}::${url}` whenever a `source` is explicitly provided so cache
 * lookup, dedup, and re-indexing are all per-(source,url). When no `source`
 * is provided the URL itself is the unique key — no composition needed.
 *
 * `ctx_search(source: "Docs")` continues to work because LIKE-mode source
 * filtering matches on the substring "Docs" inside "Docs::https://…".
 */
export function composeFetchCacheKey(source: string | undefined, url: string): string {
  return source === undefined ? url : `${source}::${url}`;
}
