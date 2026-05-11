/**
 * Slice 1 — `formatLocalDateTime` helper
 *
 * The 5-section narrative renderer needs human-readable timestamps that
 * include explicit IANA timezone disclosure ("Europe/Istanbul") so the
 * user can never misread the time as UTC. The format Mert approved:
 *
 *   "28 Apr 2026 at 12:16 (Europe/Istanbul)"
 *
 * Implementation lives in src/session/analytics.ts and is consumed by
 * formatReport's section 1 ("Where you are now") + the rescue-event
 * line. Keeping it pure (ms → string) makes it trivially testable
 * without mocking Date or process.env.
 */

import { describe, expect, test } from "vitest";
import { formatLocalDateTime } from "../../src/session/analytics.js";

describe("formatLocalDateTime", () => {
  test("renders '28 Apr 2026 at 12:16 (Europe/Istanbul)' for the canonical fixture", () => {
    // 2026-04-28T09:16:00Z = 12:16 Europe/Istanbul (UTC+03:00, no DST)
    const ms = Date.UTC(2026, 3, 28, 9, 16, 0);
    expect(formatLocalDateTime(ms, "en-TR", "Europe/Istanbul"))
      .toBe("28 Apr 2026 at 12:16 (Europe/Istanbul)");
  });

  test("uses 24-hour clock with zero-padded minutes", () => {
    // 2026-05-09T17:54:00Z = 20:54 Europe/Istanbul
    const ms = Date.UTC(2026, 4, 9, 17, 54, 0);
    expect(formatLocalDateTime(ms, "en-TR", "Europe/Istanbul"))
      .toBe("9 May 2026 at 20:54 (Europe/Istanbul)");
  });

  test("appends the IANA timezone in parentheses regardless of locale", () => {
    const ms = Date.UTC(2026, 0, 1, 12, 0, 0);
    const out = formatLocalDateTime(ms, "en-US", "America/New_York");
    expect(out).toMatch(/\(America\/New_York\)$/);
  });

  test("returns a stable empty-ish string when ms is 0 or invalid", () => {
    expect(formatLocalDateTime(0, "en-TR", "Europe/Istanbul")).toBe("");
    expect(formatLocalDateTime(Number.NaN, "en-TR", "Europe/Istanbul")).toBe("");
  });
});
