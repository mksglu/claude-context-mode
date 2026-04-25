/**
 * Behavioral tests for src/truncate.ts.
 *
 * The existing truncate-removal.test.ts only checks source-level exports.
 * These tests exercise actual behavior: byte-safe truncation boundaries,
 * multi-byte UTF-8 safety, the `maxBytes <= marker length` edge case, and
 * XML escaping of all five reserved characters.
 */

import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { truncateJSON, capBytes, escapeXML } from "../src/truncate.js";

// ─────────────────────────────────────────────────────────
// truncateJSON
// ─────────────────────────────────────────────────────────

describe("truncateJSON", () => {
  test("returns full JSON when under the byte cap", () => {
    const out = truncateJSON({ a: 1, b: 2 }, 1000);
    assert.equal(out, JSON.stringify({ a: 1, b: 2 }, null, 2));
  });

  test("appends marker when serialized content exceeds maxBytes", () => {
    const big = { text: "x".repeat(500) };
    const out = truncateJSON(big, 100);
    assert.ok(out.endsWith("... [truncated]"));
    assert.ok(Buffer.byteLength(out) <= 100);
  });

  test("serializes null when value is undefined", () => {
    const out = truncateJSON(undefined, 1000);
    assert.equal(out, "null");
  });

  test("respects compact indent=0", () => {
    const out = truncateJSON({ a: 1 }, 1000, 0);
    assert.equal(out, '{"a":1}');
  });

  test("never exceeds maxBytes, including with 4-byte UTF-8 chars", () => {
    // "🎉" is 4 bytes in UTF-8. A string of these will trip naive slicing.
    const value = { emoji: "🎉".repeat(100) };
    const cap = 50;
    const out = truncateJSON(value, cap);
    assert.ok(
      Buffer.byteLength(out) <= cap,
      `expected <= ${cap} bytes, got ${Buffer.byteLength(out)}`,
    );
    assert.ok(out.endsWith("... [truncated]"));
  });

  test("degenerate maxBytes smaller than marker still respects byte cap", () => {
    // Marker "... [truncated]" is 15 bytes. Ask for 5.
    const out = truncateJSON({ big: "x".repeat(100) }, 5);
    assert.ok(
      Buffer.byteLength(out) <= 5,
      `expected <= 5 bytes, got ${Buffer.byteLength(out)}: ${JSON.stringify(out)}`,
    );
  });

  test("maxBytes=0 returns empty string", () => {
    const out = truncateJSON({ a: 1 }, 0);
    assert.equal(Buffer.byteLength(out), 0);
  });
});

// ─────────────────────────────────────────────────────────
// capBytes
// ─────────────────────────────────────────────────────────

describe("capBytes", () => {
  test("returns input unchanged when within cap", () => {
    assert.equal(capBytes("hello", 100), "hello");
  });

  test("returns input unchanged when exactly at cap", () => {
    assert.equal(capBytes("hello", 5), "hello");
  });

  test("truncates and appends ellipsis when over cap", () => {
    const out = capBytes("hello world", 8);
    assert.ok(out.endsWith("..."));
    assert.ok(Buffer.byteLength(out) <= 8);
  });

  test("never splits a multi-byte UTF-8 character", () => {
    // Each emoji is 4 bytes. Asking for 10 bytes must produce valid UTF-8.
    const input = "🎉🎉🎉🎉🎉";
    const out = capBytes(input, 10);
    assert.ok(Buffer.byteLength(out) <= 10);
    // Decoding round-trip should match itself — no replacement characters.
    assert.equal(Buffer.from(out, "utf-8").toString("utf-8"), out);
    assert.ok(out.endsWith("..."));
  });

  test("degenerate maxBytes smaller than ellipsis respects byte cap", () => {
    const out = capBytes("hello world", 2);
    assert.ok(
      Buffer.byteLength(out) <= 2,
      `expected <= 2 bytes, got ${Buffer.byteLength(out)}: ${JSON.stringify(out)}`,
    );
  });

  test("maxBytes=0 returns empty string", () => {
    assert.equal(capBytes("anything", 0), "");
  });

  test("never produces a lone surrogate at the truncation boundary", () => {
    // When the byte budget falls between the high and low surrogate of an
    // emoji, a naive slice would leave a lone surrogate that encodes as
    // U+FFFD. The output must not contain replacement characters.
    const input = "🎉".repeat(20);
    for (let cap = 4; cap <= 40; cap++) {
      const out = capBytes(input, cap);
      assert.ok(
        !out.includes("\uFFFD"),
        `cap=${cap} produced replacement char: ${JSON.stringify(out)}`,
      );
      assert.ok(
        Buffer.byteLength(out) <= cap,
        `cap=${cap} produced ${Buffer.byteLength(out)} bytes`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────
// escapeXML
// ─────────────────────────────────────────────────────────

describe("escapeXML", () => {
  test("escapes all five reserved characters", () => {
    assert.equal(
      escapeXML(`a & b < c > d " e ' f`),
      "a &amp; b &lt; c &gt; d &quot; e &apos; f",
    );
  });

  test("ampersand is escaped first to avoid double-escaping", () => {
    // If `&` were escaped after `<`, "&lt;" would become "&amp;lt;".
    assert.equal(escapeXML("<tag>"), "&lt;tag&gt;");
  });

  test("returns identical string when nothing to escape", () => {
    assert.equal(escapeXML("plain text 123"), "plain text 123");
  });

  test("handles empty string", () => {
    assert.equal(escapeXML(""), "");
  });

  test("preserves non-ASCII characters unchanged", () => {
    assert.equal(escapeXML("café 🎉 <x>"), "café 🎉 &lt;x&gt;");
  });
});

// ─────────────────────────────────────────────────────────
// Additional edge cases — codepoint boundary arithmetic,
// modern emoji sequences, and marker-length arithmetic.
// ─────────────────────────────────────────────────────────

describe("capBytes — codepoint boundary edge cases", () => {
  test("byte-safe across 3-byte UTF-8 (CJK) input at every cap", () => {
    // Each "日" is 3 bytes in UTF-8 — the gap between ASCII and 4-byte emoji
    // that the existing surrogate test does not exercise.
    const input = "日本語テスト".repeat(5);
    for (let cap = 0; cap <= Buffer.byteLength(input) + 4; cap++) {
      const out = capBytes(input, cap);
      assert.ok(
        Buffer.byteLength(out) <= cap,
        `cap=${cap} produced ${Buffer.byteLength(out)} bytes`,
      );
      assert.ok(
        !out.includes("\uFFFD"),
        `cap=${cap} leaked replacement char: ${JSON.stringify(out)}`,
      );
    }
  });

  test("handles ZWJ emoji sequences without splitting surrogate pairs", () => {
    // Family emoji is 3 surrogate-pair emoji joined by ZWJ (U+200D).
    // Each component has a surrogate pair; slicing mid-pair would leak U+FFFD.
    const family = "👨\u200D👩\u200D👧";
    for (let cap = 0; cap <= Buffer.byteLength(family) + 4; cap++) {
      const out = capBytes(family, cap);
      assert.ok(Buffer.byteLength(out) <= cap);
      assert.ok(
        !out.includes("\uFFFD"),
        `cap=${cap} leaked replacement char: ${JSON.stringify(out)}`,
      );
    }
  });

  test("tolerates a lone low surrogate in input and truncates to ASCII prefix", () => {
    // Lone low surrogate (not preceded by a high one) is malformed UTF-16.
    // When the byte budget ends inside the 3-byte ASCII prefix, the output
    // must be a deterministic ASCII prefix plus the ellipsis — not a
    // mid-codepoint slice and not a panic. We pin the exact expected output
    // to lock the `byteSafePrefix` arithmetic rather than assert a tautology.
    const malformed = "abc\uDC00def";
    assert.equal(capBytes(malformed, 5), "ab...");
    assert.equal(capBytes(malformed, 6), "abc...");
    // A cap above ASCII prefix still must not panic or crash on the encoder.
    const out = capBytes(malformed, 7);
    assert.ok(Buffer.byteLength(out) <= 7);
  });

  test("returns input unchanged when cap >= input byte length (mixed-width sweep)", () => {
    // Locks the contract: no truncation work above the threshold, regardless
    // of how the bytes are distributed across 1/3/4-byte codepoints.
    const input = "🎉日a".repeat(20);
    const inputBytes = Buffer.byteLength(input);
    for (let cap = inputBytes; cap <= inputBytes + 10; cap++) {
      assert.equal(capBytes(input, cap), input, `cap=${cap} mutated input`);
    }
  });
});

describe("capBytes — marker-boundary arithmetic", () => {
  test("cap exactly equal to ellipsis marker length returns just the marker", () => {
    // Marker "..." is 3 bytes. cap=3 with over-budget input → "..." alone.
    assert.equal(capBytes("long input", 3), "...");
  });

  test("cap one byte above marker length returns one content byte + marker", () => {
    const out = capBytes("abcdef", 4);
    assert.equal(out, "a...");
    assert.equal(Buffer.byteLength(out), 4);
  });
});

describe("escapeXML — consecutive and pre-escaped input", () => {
  test("escapes runs of reserved characters independently", () => {
    assert.equal(escapeXML("&&&"), "&amp;&amp;&amp;");
    assert.equal(escapeXML("<<<"), "&lt;&lt;&lt;");
    assert.equal(escapeXML(`"""`), "&quot;&quot;&quot;");
  });

  test("re-escapes already-escaped input (not idempotent by design)", () => {
    // escapeXML is a one-shot transform; calling it on pre-escaped input
    // will double-escape. Lock this so nobody introduces silent idempotency
    // that would mangle legitimate ampersand-prefixed content.
    assert.equal(escapeXML("&amp;"), "&amp;amp;");
    assert.equal(escapeXML("&lt;tag&gt;"), "&amp;lt;tag&amp;gt;");
  });
});

describe("truncateJSON — exact-size boundaries", () => {
  test("returns full serialization unchanged when cap equals its byte length", () => {
    const value = { k: "v", n: 42 };
    const serialized = JSON.stringify(value, null, 2);
    const out = truncateJSON(value, Buffer.byteLength(serialized));
    assert.equal(out, serialized);
  });

  test("appends marker and honors cap when cap is one byte below full size", () => {
    const value = { text: "hello world from truncateJSON" };
    const full = JSON.stringify(value, null, 2);
    const cap = Buffer.byteLength(full) - 1;
    const out = truncateJSON(value, cap);
    assert.ok(out.endsWith("... [truncated]"));
    assert.ok(
      Buffer.byteLength(out) <= cap,
      `expected <= ${cap} bytes, got ${Buffer.byteLength(out)}`,
    );
  });
});
