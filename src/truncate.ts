/**
 * truncate — Pure string truncation and escaping utilities for context-mode.
 *
 * These helpers are used by the core ContentStore (chunking) and
 * SessionDB (snapshot building). They are extracted here so any
 * consumer can import them without pulling in the full store or executor.
 */

// ─────────────────────────────────────────────────────────
// String truncation
// ─────────────────────────────────────────────────────────

/**
 * Truncate a string to at most `maxChars` characters, appending an ellipsis
 * when truncation occurs.
 *
 * @param str     - Input string.
 * @param maxChars - Maximum character count (inclusive). Must be >= 3.
 * @returns The original string if short enough, otherwise a truncated string
 *          ending with "...".
 */
export function truncateString(str: string, maxChars: number): string {
  if (str.length <= maxChars) return str;
  return str.slice(0, Math.max(0, maxChars - 3)) + "...";
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

  // Find the largest character slice that stays within maxBytes once encoded.
  // Buffer.byteLength is O(n) but we only call it once per truncation.
  const marker = "... [truncated]";
  const markerBytes = Buffer.byteLength(marker);
  const budget = maxBytes - markerBytes;

  // Binary-search for the right character count — avoids O(n²) scanning.
  let lo = 0;
  let hi = serialized.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(serialized.slice(0, mid)) <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return serialized.slice(0, lo) + marker;
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
 * @param str      - Input string.
 * @param maxBytes - Hard byte cap.
 */
export function capBytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str) <= maxBytes) return str;
  const marker = "...";
  const markerBytes = Buffer.byteLength(marker);
  const budget = maxBytes - markerBytes;

  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(str.slice(0, mid)) <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return str.slice(0, lo) + marker;
}
