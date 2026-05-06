import { describe, expect, test } from "vitest";
import { SearchThrottle } from "../src/search/throttle.js";

describe("SearchThrottle", () => {
  test("scopes counters by session key", () => {
    const throttle = new SearchThrottle({ windowMs: 60_000, maxResultsAfter: 3, blockAfter: 8, normalMaxResults: 2 });

    throttle.record("session-a", 3, 1_000);
    throttle.record("session-a", 3, 1_001);
    throttle.record("session-a", 3, 1_002);
    const limited = throttle.record("session-a", 3, 1_003);
    const otherSession = throttle.record("session-b", 3, 1_004);

    expect(limited.callCount).toBe(4);
    expect(limited.effectiveLimit).toBe(1);
    expect(otherSession.callCount).toBe(1);
    expect(otherSession.effectiveLimit).toBe(2);
  });

  test("blocks only after configured threshold inside window", () => {
    const throttle = new SearchThrottle({ windowMs: 100, maxResultsAfter: 1, blockAfter: 2, normalMaxResults: 2 });

    expect(throttle.record("session", 5, 10).blocked).toBe(false);
    expect(throttle.record("session", 5, 20).blocked).toBe(false);
    expect(throttle.record("session", 5, 30).blocked).toBe(true);
    expect(throttle.record("session", 5, 200).blocked).toBe(false);
  });
});
