/**
 * Slice 2 — `renderHorizontalTimeline` helper
 *
 * Section 1 of the 5-section narrative ("How that X.X MB built up") needs
 * a horizontal proportional-spacing strip showing where each ACTIVE day,
 * the PEAK day, and any /compact RESCUE event landed across the
 * conversation lifespan. The Mert-approved demo:
 *
 *     apr 28 ●──────────────────────●────█──────────────────────◆────● may 10
 *
 *       apr 28   277 captures
 *       may 3    201 captures
 *       may 4    438 captures  ← peak
 *       may 9    261 captures  ◆ /compact rescued 1552 KB
 *       may 10   100 captures
 *
 *     ●  active day      █  peak day      ◆  /compact rescue
 *
 * Contract:
 * - Strip is exactly 56 chars wide between the bookend labels.
 * - Day-1 sits at column 0; final day sits at column 55. Other active
 *   days sit at `round((day - first) / (last - first) * 55)`.
 * - Peak day overrides active mark with `█`. Rescue overlays as `◆`
 *   (rescue wins over both, since it's the headline event).
 * - Daily detail list shows captures count + " ← peak" + "◆ /compact
 *   rescued N KB" annotations on the relevant rows.
 * - Legend always renders so the glyphs are decoded.
 *
 * Returns string[] (one element per output line) so the caller can
 * splice directly into the formatReport line buffer.
 */

import { describe, expect, test } from "vitest";
import { renderHorizontalTimeline } from "../../src/session/analytics.js";
import type { TimelineDay } from "../../src/session/analytics.js";

function fixtureDays(): TimelineDay[] {
  // Mirrors the target output exactly:
  //   apr 28 → may 10 (13-day span, 5 active days).
  return [
    { ms: Date.UTC(2026, 3, 28),  count: 277 },
    { ms: Date.UTC(2026, 4,  3),  count: 201 },
    { ms: Date.UTC(2026, 4,  4),  count: 438 },  // peak
    { ms: Date.UTC(2026, 4,  9),  count: 261, rescueBytes: 1552 * 1024 },
    { ms: Date.UTC(2026, 4, 10),  count: 100 },
  ];
}

describe("renderHorizontalTimeline", () => {
  test("emits the bookended strip line + a 5-row detail list + legend", () => {
    const lines = renderHorizontalTimeline(fixtureDays(), "en-TR", "Europe/Istanbul");
    const text = lines.join("\n");

    // 1. Strip line: bookend labels + at least one active glyph.
    expect(text).toMatch(/apr 28[\s\S]*may 10/);
    expect(text).toMatch(/●/);

    // 2. Daily detail list — every fixture day appears with its count.
    expect(text).toMatch(/apr 28\s+277 captures/);
    expect(text).toMatch(/may 3\s+201 captures/);
    expect(text).toMatch(/may 4\s+438 captures\s+← peak/);
    expect(text).toMatch(/may 9\s+261 captures\s+◆ \/compact rescued 1552 KB/);
    expect(text).toMatch(/may 10\s+100 captures/);

    // 3. Legend.
    expect(text).toMatch(/●\s+active day/);
    expect(text).toMatch(/█\s+peak day/);
    expect(text).toMatch(/◆\s+\/compact rescue/);
  });

  test("strip places active marks proportionally across a 56-char span", () => {
    const lines = renderHorizontalTimeline(fixtureDays(), "en-TR", "Europe/Istanbul");
    const stripLine = lines.find((l) => /apr 28.*may 10/.test(l));
    expect(stripLine).toBeTruthy();
    // The strip body lives between "apr 28 " and " may 10".
    const m = stripLine!.match(/apr 28 (.*) may 10/);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body.length).toBe(56);
    // Day 1 (apr 28) is at column 0; day 13 (may 10) is at column 55.
    expect(body.charAt(0)).toBe("●");
    expect(body.charAt(55)).toBe("●");
    // Day 7 (may 4 = peak) → round(6/12 * 55) = column 28 → "█".
    expect(body.charAt(28)).toBe("█");
    // Day 12 (may 9 = rescue) → round(11/12 * 55) = column 50 → "◆".
    expect(body.charAt(50)).toBe("◆");
    // Filler is the box-drawing dash character.
    expect(body.charAt(1)).toBe("─");
  });

  test("rescue overlays peak when both fall on the same day", () => {
    const days: TimelineDay[] = [
      { ms: Date.UTC(2026, 0, 1), count: 10 },
      { ms: Date.UTC(2026, 0, 5), count: 999, rescueBytes: 100 * 1024 }, // peak + rescue
      { ms: Date.UTC(2026, 0, 9), count: 20 },
    ];
    const lines = renderHorizontalTimeline(days, "en-TR", "Europe/Istanbul");
    const text = lines.join("\n");
    // Detail row carries both peak + rescue annotations.
    expect(text).toMatch(/jan 5\s+999 captures\s+← peak\s+◆ \/compact rescued 100 KB/);
  });

  test("returns [] when zero active days", () => {
    expect(renderHorizontalTimeline([], "en-TR", "Europe/Istanbul")).toEqual([]);
  });
});
