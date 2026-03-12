/**
 * Tests for ctx_batch_execute input coercion (string → array normalization).
 *
 * LLMs sometimes pass `commands` and `queries` as JSON strings instead of
 * arrays, or pass commands as plain strings instead of {label, command}
 * objects. These tests verify that z.preprocess() coerces all three cases
 * gracefully rather than throwing -32602 validation errors.
 */

import { describe, test, expect } from "vitest";
import { z } from "zod";

// ── Replicate the schemas from server.ts ─────────────────────────────────────

const commandItemSchema = z.object({
  label: z.string(),
  command: z.string(),
});

const commandsSchemaStrict = z.array(commandItemSchema).min(1);

const commandsSchemaCoerced = z.preprocess((val) => {
  let arr = val;
  if (typeof val === "string") {
    try {
      arr = JSON.parse(val);
    } catch {
      return val;
    }
  }
  if (Array.isArray(arr)) {
    return arr.map((item, i) =>
      typeof item === "string" ? { label: `cmd ${i + 1}`, command: item } : item,
    );
  }
  return arr;
}, z.array(commandItemSchema).min(1));

const queriesSchemaStrict = z.array(z.string()).min(1);

const queriesSchemaCoerced = z.preprocess((val) => {
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [val];
    } catch {
      return [val];
    }
  }
  return val;
}, z.array(z.string()).min(1));

// ── commands coercion ─────────────────────────────────────────────────────────

describe("ctx_batch_execute commands coercion", () => {
  test("strict schema rejects JSON string input", () => {
    const input = JSON.stringify([{ label: "test", command: "echo hi" }]);
    const result = commandsSchemaStrict.safeParse(input);
    expect(result.success).toBe(false);
  });

  test("strict schema rejects array of plain strings", () => {
    const result = commandsSchemaStrict.safeParse(["echo hi", "echo bye"]);
    expect(result.success).toBe(false);
  });

  test("coerced schema accepts JSON string of {label,command} objects", () => {
    const input = JSON.stringify([{ label: "greet", command: "echo hi" }]);
    const result = commandsSchemaCoerced.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([{ label: "greet", command: "echo hi" }]);
    }
  });

  test("coerced schema wraps plain string array into {label,command} objects", () => {
    const result = commandsSchemaCoerced.safeParse(["echo hello", "echo world"]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([
        { label: "cmd 1", command: "echo hello" },
        { label: "cmd 2", command: "echo world" },
      ]);
    }
  });

  test("coerced schema passes through already-valid array of objects", () => {
    const input = [{ label: "run", command: "ls -la" }];
    const result = commandsSchemaCoerced.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
    }
  });
});

// ── queries coercion ──────────────────────────────────────────────────────────

describe("ctx_batch_execute queries coercion", () => {
  test("strict schema rejects JSON string input", () => {
    const input = JSON.stringify(["search term one", "search term two"]);
    const result = queriesSchemaStrict.safeParse(input);
    expect(result.success).toBe(false);
  });

  test("coerced schema accepts JSON string of queries array", () => {
    const input = JSON.stringify(["search term one", "search term two"]);
    const result = queriesSchemaCoerced.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(["search term one", "search term two"]);
    }
  });

  test("coerced schema wraps bare string into single-element array", () => {
    const result = queriesSchemaCoerced.safeParse("find rate limit");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(["find rate limit"]);
    }
  });

  test("coerced schema passes through already-valid string array", () => {
    const input = ["q1", "q2", "q3"];
    const result = queriesSchemaCoerced.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
    }
  });
});
