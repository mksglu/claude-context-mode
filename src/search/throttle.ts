export type SearchThrottleDecision = {
  callCount: number;
  elapsedMs: number;
  effectiveLimit: number;
  blocked: boolean;
};

type SearchThrottleState = {
  callCount: number;
  windowStart: number;
};

export type SearchThrottleOptions = {
  windowMs?: number;
  maxResultsAfter?: number;
  blockAfter?: number;
  normalMaxResults?: number;
};

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_RESULTS_AFTER = 3;
const DEFAULT_BLOCK_AFTER = 8;
const DEFAULT_NORMAL_MAX_RESULTS = 2;

/**
 * Tracks ctx_search pressure per scope so one project/session cannot throttle
 * another when a single MCP process serves multiple clients.
 */
export class SearchThrottle {
  readonly #states = new Map<string, SearchThrottleState>();
  readonly #windowMs: number;
  readonly #maxResultsAfter: number;
  readonly #blockAfter: number;
  readonly #normalMaxResults: number;

  constructor(options: SearchThrottleOptions = {}) {
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#maxResultsAfter = options.maxResultsAfter ?? DEFAULT_MAX_RESULTS_AFTER;
    this.#blockAfter = options.blockAfter ?? DEFAULT_BLOCK_AFTER;
    this.#normalMaxResults = options.normalMaxResults ?? DEFAULT_NORMAL_MAX_RESULTS;
  }

  record(scopeKey: string, requestedLimit: number, now = Date.now()): SearchThrottleDecision {
    const key = scopeKey || "default";
    let state = this.#states.get(key);
    if (!state || now - state.windowStart > this.#windowMs) {
      state = { callCount: 0, windowStart: now };
      this.#states.set(key, state);
    }

    state.callCount += 1;
    const effectiveLimit = state.callCount > this.#maxResultsAfter
      ? 1
      : Math.min(requestedLimit, this.#normalMaxResults);

    return {
      callCount: state.callCount,
      elapsedMs: now - state.windowStart,
      effectiveLimit,
      blocked: state.callCount > this.#blockAfter,
    };
  }

  reset(scopeKey?: string): void {
    if (scopeKey) {
      this.#states.delete(scopeKey);
      return;
    }
    this.#states.clear();
  }
}
