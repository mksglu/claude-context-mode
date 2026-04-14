/**
 * truncate — Pure string truncation and escaping utilities for context-mode.
 *
 * These helpers are used by the core ContentStore (chunking) and
 * SessionDB (snapshot building). They are extracted here so any
 * consumer can import them without pulling in the full store or executor.
 */

// ─────────────────────────────────────────────────────────
// Internal: byte-safe prefix
// ─────────────────────────────────────────────────────────

/**
 * Return the longest character-prefix of `str` whose UTF-8 encoding is at
 * most `maxBytes` bytes. Uses binary search to avoid O(n²) scanning. Returns
 * "" when `maxBytes` is <= 0 so callers never exceed their budget.
 *
 * Guards against splitting a UTF-16 surrogate pair: if the prefix would end
 * on a lone high surrogate, back off one code unit so the result round-trips
 * through UTF-8 without producing a U+FFFD replacement character.
 */
function byteSafePrefix(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(str) <= maxBytes) return str;

  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(str.slice(0, mid)) <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  // If we landed between a high and low surrogate, back off so the prefix
  // ends on a valid code point boundary.
  if (lo > 0) {
    const code = str.charCodeAt(lo - 1);
    if (code >= 0xd800 && code <= 0xdbff) lo -= 1;
  }
  return str.slice(0, lo);
}

// ─────────────────────────────────────────────────────────
// JSON truncation
// ─────────────────────────────────────────────────────────

/**
 * Serialize a value to JSON, then truncate the result to `maxBytes` bytes.
 * If truncation occurs, the string is cut at a UTF-8-safe boundary and
 * "... [truncated]" is appended. The result is NOT guaranteed to be valid
 * JSON after truncation — it is suitable only for display/logging.
 *
 * The returned string is always <= `maxBytes` bytes. When `maxBytes` is
 * smaller than the marker, the marker itself is byte-safely truncated.
 *
 * @param value    - Any JSON-serializable value.
 * @param maxBytes - Maximum byte length of the returned string.
 * @param indent   - JSON indentation spaces (default 2). Pass 0 for compact.
 */
export function truncateJSON(
  value: unknown,
  maxBytes: number,
  indent: number = 2,
): string {
  const serialized = JSON.stringify(value, null, indent) ?? "null";
  if (Buffer.byteLength(serialized) <= maxBytes) return serialized;

  const marker = "... [truncated]";
  const markerBytes = Buffer.byteLength(marker);

  // Degenerate budget: can't fit serialized content + marker. Fit as much of
  // the marker as we can so the return still honors `maxBytes`.
  if (maxBytes <= markerBytes) return byteSafePrefix(marker, maxBytes);

  return byteSafePrefix(serialized, maxBytes - markerBytes) + marker;
}

// ─────────────────────────────────────────────────────────
// XML / HTML escaping
// ─────────────────────────────────────────────────────────

/**
 * Escape a string for safe embedding in an XML or HTML attribute or text node.
 * Replaces the five XML-reserved characters: `&`, `<`, `>`, `"`, `'`.
 *
 * Used by the resume snapshot template builder to embed user content in
 * `<tool_response>` and `<user_message>` XML tags without breaking the
 * structured prompt format.
 */
export function escapeXML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─────────────────────────────────────────────────────────
// maxBytes guard
// ─────────────────────────────────────────────────────────

/**
 * Return `str` unchanged if it fits within `maxBytes`, otherwise return a
 * byte-safe slice with an ellipsis appended. Useful for single-value fields
 * (e.g., tool response strings) where head+tail splitting is not needed.
 *
 * The returned string is always <= `maxBytes` bytes. When `maxBytes` is
 * smaller than the ellipsis marker, the marker itself is byte-safely truncated.
 *
 * @param str      - Input string.
 * @param maxBytes - Hard byte cap.
 */
export function capBytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str) <= maxBytes) return str;

  const marker = "...";
  const markerBytes = Buffer.byteLength(marker);

  if (maxBytes <= markerBytes) return byteSafePrefix(marker, maxBytes);

  return byteSafePrefix(str, maxBytes - markerBytes) + marker;
}
