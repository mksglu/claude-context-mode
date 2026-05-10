/**
 * Slice 3 — `renderCostExample` helper
 *
 * Section 4 of the 5-section narrative ("For example: what would that
 * cost?") translates lifetime tokens into a relatable Opus dollar figure
 * + alternate-model scale row + tangible comparisons (Cursor Pro months,
 * Claude Max months, weekends of API coding) + 10-dev team scale, all
 * capped with an EXAMPLES disclaimer so users never confuse it for an
 * actual bill.
 *
 * The Mert-approved demo (target output, /Users/mksglu/.../target.txt):
 *
 *   context-mode kept 356.0 MB (93.3M tokens) out of your AI's context.
 *   If those tokens had hit Opus 4 ($15 per 1M input):
 *
 *     $1399.73  on Opus 4 input alone
 *
 *   That's roughly:
 *     · 70 months of Cursor Pro ($20/mo)
 *     · 7.0 months of Claude Max ($200/mo)
 *     · 19 weekends of nonstop API coding
 *
 *   At a 10-dev team scale: ~$13997 over 67 days, or ~$76254/year.
 *
 *   Different model? Math scales:
 *     Sonnet 4  $279.95  ·  GPT-4o $233.29  ·  Gemini 2 $116.64  ·  Haiku 4 $74.65
 *
 *   These are EXAMPLES, not your actual bill — your model and rates may differ.
 *
 * Contract: pure (lifetimeBytes, lifetimeTokens, lifetimeDays) → string[]
 * with no IO. The byte → MB and token → M format match `kb()` / `fmtNum()`
 * already defined in analytics.ts.
 */

import { describe, expect, test } from "vitest";
import { renderCostExample } from "../../src/session/analytics.js";

describe("renderCostExample", () => {
  // Canonical fixture: 356 MB / 93.3M tokens / 67 days → $1399.73 on Opus 4.
  // Token count back-solved from the target dollar figure so the math is
  // numerically exact:
  //   1399.73 USD = tokens × 15 / 1e6  →  tokens = 93_315_333
  // Lifetime byte total stays at 356 MB even though the implied byte/token
  // ratio (3.81) doesn't match — the helper's only job is to render what
  // the caller passes, not to derive bytes from tokens.
  const LIFETIME_BYTES  = 356 * 1024 * 1024;
  const LIFETIME_TOKENS = 93_315_333;
  const LIFETIME_DAYS   = 67;

  test("emits the headline byte/token tally + Opus-4 dollar figure", () => {
    const text = renderCostExample(LIFETIME_BYTES, LIFETIME_TOKENS, LIFETIME_DAYS).join("\n");
    expect(text).toMatch(/\$1399\.73 of Opus 4 tokens your team didn't burn/);
  });

  test("mentions Cursor Pro paid for itself", () => {
    const text = renderCostExample(LIFETIME_BYTES, LIFETIME_TOKENS, LIFETIME_DAYS).join("\n");
    expect(text).toMatch(/Cursor Pro paid for itself/);
  });

  test("includes the 10-dev team scale projection", () => {
    const text = renderCostExample(LIFETIME_BYTES, LIFETIME_TOKENS, LIFETIME_DAYS).join("\n");
    expect(text).toMatch(/Scale across a 10-dev team/);
    expect(text).toMatch(/\$[\d,]+\/year saved/);
  });

  test("ends with the EXAMPLES disclaimer", () => {
    const text = renderCostExample(LIFETIME_BYTES, LIFETIME_TOKENS, LIFETIME_DAYS).join("\n");
    expect(text).toMatch(/Opus rates shown for context/);
    expect(text).toMatch(/savings ratio holds/);
  });

  test("returns [] when lifetime tokens is zero", () => {
    expect(renderCostExample(0, 0, 0)).toEqual([]);
  });
});
