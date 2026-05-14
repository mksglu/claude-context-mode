import { describe, expect, test } from "vitest";
import { withRetry, withRetryAsync } from "../../src/db-base.js";

describe("db-base retry backoff", () => {
  test("sync retry does not poll Date.now in a CPU spin loop", () => {
    const originalNow = Date.now;
    let calls = 0;
    Date.now = () => {
      throw new Error("Date.now polling means busy-spin");
    };
    try {
      const result = withRetry(() => {
        calls++;
        if (calls === 1) throw new Error("SQLITE_BUSY: database is locked");
        return "ok";
      }, [1]);
      expect(result).toBe("ok");
      expect(calls).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });

  test("async retry yields the event loop between attempts", async () => {
    let calls = 0;
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 0);

    const result = await withRetryAsync(async () => {
      calls++;
      if (calls === 1) throw new Error("SQLITE_BUSY");
      return "ok";
    }, [10]);

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(timerFired).toBe(true);
  });

  test("async retry surfaces SQLITE_BUSY after bounded attempts", async () => {
    let calls = 0;
    await expect(withRetryAsync(() => {
      calls++;
      throw new Error("SQLITE_BUSY");
    }, [0, 0])).rejects.toThrow(/after 2 retries/);
    expect(calls).toBe(3);
  });
});
