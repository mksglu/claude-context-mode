import { SearchThrottle } from "../search/throttle.js";

export const SEARCH_WINDOW_MS = 60_000;
export const SEARCH_MAX_RESULTS_AFTER = 3;
export const SEARCH_BLOCK_AFTER = 8;

export function createSearchThrottle(): SearchThrottle {
  return new SearchThrottle({
    windowMs: SEARCH_WINDOW_MS,
    maxResultsAfter: SEARCH_MAX_RESULTS_AFTER,
    blockAfter: SEARCH_BLOCK_AFTER,
    normalMaxResults: 2,
  });
}

/**
 * Defensive coercion: parse stringified JSON arrays.
 * Works around clients that send arrays as JSON strings.
 */
export function coerceJsonArray(val: unknown): unknown {
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // let zod handle invalid values
    }
  }
  return val;
}

/**
 * Coerce commands array: handles double-serialization AND plain
 * command strings instead of {label, command} objects.
 */
export function coerceCommandsArray(val: unknown): unknown {
  const arr = coerceJsonArray(val);
  if (Array.isArray(arr)) {
    return arr.map((item, i) =>
      typeof item === "string" ? { label: `cmd_${i + 1}`, command: item } : item,
    );
  }
  return arr;
}
