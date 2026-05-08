/**
 * RED test: truncateString must NOT be exported from src/truncate.ts.
 *
 * This test verifies the function was fully removed. It reads the source
 * file and asserts the symbol is absent. It also verifies escapeXML,
 * truncateJSON, and capBytes remain intact.
 */

import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("truncateString removal", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "src", "truncate.ts"),
    "utf-8",
  );

  test("truncateString is not exported from src/truncate.ts", () => {
    assert.ok(
      !src.includes("truncateString"),
      "src/truncate.ts still contains 'truncateString'",
    );
  });

  test("escapeXML is still exported", () => {
    assert.ok(
      src.includes("export function escapeXML"),
      "escapeXML export is missing",
    );
  });

  test("truncateJSON is still exported", () => {
    assert.ok(
      src.includes("export function truncateJSON"),
      "truncateJSON export is missing",
    );
  });

  test("capBytes is still exported", () => {
    assert.ok(
      src.includes("export function capBytes"),
      "capBytes export is missing",
    );
  });
});
