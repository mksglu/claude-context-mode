/**
 * Tests for ctx_batch_execute command-object label coercion.
 *
 * LLMs often emit command items shaped like {command, description} instead of
 * the required {label, command}. The coercer synthesizes a `label` from a
 * sensible fallback field (description / name / title) or a positional index,
 * so validation no longer rejects these otherwise-well-formed payloads.
 */

import { describe, test, expect } from "vitest";
import { z } from "zod";

const commandItemSchema = z.object({
  label: z.string(),
  command: z.string(),
});

function coerceJsonArray(val: unknown): unknown {
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return val;
}

function coerceCommandsArray(val: unknown): unknown {
  const arr = coerceJsonArray(val);
  if (!Array.isArray(arr)) return arr;
  return arr.map((item, i) => {
    if (typeof item === "string") {
      return { label: `cmd_${i + 1}`, command: item };
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      if (typeof obj.label !== "string" || obj.label.length === 0) {
        const fallback =
          (typeof obj.description === "string" && obj.description) ||
          (typeof obj.name === "string" && obj.name) ||
          (typeof obj.title === "string" && obj.title) ||
          `cmd_${i + 1}`;
        return { ...obj, label: fallback };
      }
    }
    return item;
  });
}

const commandsSchema = z.preprocess(
  coerceCommandsArray,
  z.array(commandItemSchema.passthrough()).min(1),
);

describe("ctx_batch_execute label coercion for objects missing `label`", () => {
  test("synthesizes label from description when label is absent", () => {
    const result = commandsSchema.safeParse([
      { command: "ls -la", description: "List repo root" },
    ]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[0].label).toBe("List repo root");
      expect(result.data[0].command).toBe("ls -la");
    }
  });

  test("falls back to name when description is missing", () => {
    const result = commandsSchema.safeParse([
      { command: "git status", name: "status-check" },
    ]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data[0].label).toBe("status-check");
  });

  test("falls back to title when description and name are missing", () => {
    const result = commandsSchema.safeParse([
      { command: "pwd", title: "current-dir" },
    ]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data[0].label).toBe("current-dir");
  });

  test("falls back to cmd_N when no label-like field is present", () => {
    const result = commandsSchema.safeParse([
      { command: "echo a" },
      { command: "echo b" },
    ]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[0].label).toBe("cmd_1");
      expect(result.data[1].label).toBe("cmd_2");
    }
  });

  test("preserves explicit label when present", () => {
    const result = commandsSchema.safeParse([
      { label: "explicit", command: "ls", description: "ignored" },
    ]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data[0].label).toBe("explicit");
  });

  test("replaces empty-string label with a fallback", () => {
    const result = commandsSchema.safeParse([
      { label: "", command: "ls", description: "used" },
    ]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data[0].label).toBe("used");
  });

  test("mixed-shape array coerces each item independently", () => {
    const result = commandsSchema.safeParse([
      "echo plain",
      { command: "ls", description: "list" },
      { label: "explicit", command: "pwd" },
    ]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.map((c) => c.label)).toEqual([
        "cmd_1",
        "list",
        "explicit",
      ]);
    }
  });
});
