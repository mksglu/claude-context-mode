import "../setup-home";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zod3ShapeToV4 } from "../../src/adapters/opencode/zod3tov4.js";

describe("zod3ShapeToV4", () => {
  it("converts a flat Zod 3 shape to Zod v4", () => {
    const z3Shape = {
      name: z.string().describe("User name"),
      age: z.number(),
      active: z.boolean(),
    };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);

    for (const value of Object.values(result)) {
      expect(value).toHaveProperty("_zod");
      expect(typeof (value as any)._zod).toBe("object");
    }
  });

  it("preserves descriptions", () => {
    const z3Shape = { name: z.string().describe("User name") };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    expect((result.name as any).description).toBe("User name");
  });

  it("converts ZodEnum", () => {
    const z3Shape = { lang: z.enum(["js", "ts", "py"]) };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    expect((result.lang as any)._zod).toBeDefined();
  });

  it("converts ZodArray", () => {
    const z3Shape = { tags: z.array(z.string()) };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    expect((result.tags as any)._zod).toBeDefined();
  });

  it("converts ZodOptional", () => {
    const z3Shape = { name: z.string().optional() };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    expect((result.name as any)._zod).toBeDefined();
  });

  it("converts ZodNullable", () => {
    const z3Shape = { name: z.string().nullable() };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    expect((result.name as any)._zod).toBeDefined();
  });

  it("converts ZodDefault", () => {
    const z3Shape = { count: z.number().default(10) };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    expect((result.count as any)._zod).toBeDefined();
  });

  it("converts ZodDefault with function default", () => {
    const z3Shape = { items: z.array(z.string()).default(() => []) };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    expect((result.items as any)._zod).toBeDefined();
  });

  it("converts ZodRecord", () => {
    const z3Shape = { meta: z.record(z.string(), z.number()) };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    expect((result.meta as any)._zod).toBeDefined();
  });

  it("converts ZodUnion", () => {
    const z3Shape = { val: z.union([z.string(), z.number()]) };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    expect((result.val as any)._zod).toBeDefined();
  });

  it("converts nested ZodObject", () => {
    const z3Shape = {
      config: z.object({ key: z.string(), value: z.number() }),
    };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    expect((result.config as any)._zod).toBeDefined();
  });

  it("converts ZodEffects (strips to inner schema)", () => {
    const z3Shape = {
      input: z.preprocess(
        (val) => (typeof val === "string" ? val.split(",") : val),
        z.array(z.string()),
      ),
    };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    expect((result.input as any)._zod).toBeDefined();
  });

  it("returns z.unknown() for null/non-object values", () => {
    const z3Shape = { foo: null, bar: 42 };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    expect((result.foo as any)._zod).toBeDefined();
    expect((result.bar as any)._zod).toBeDefined();
  });

  it("returns z.unknown() for objects without _def", () => {
    const z3Shape = { plain: { type: "string" } };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    expect((result.plain as any)._zod).toBeDefined();
  });

  it("returns z.unknown() for unknown typeName", () => {
    const fakeSchema = { _def: { typeName: "ZodFancyNewType" } };
    const z3Shape = { x: fakeSchema };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    expect((result.x as any)._zod).toBeDefined();
  });

  it("never returns raw Zod 3 schemas (all have _zod)", () => {
    const z3Shape = {
      a: z.string(),
      b: z.number().optional(),
      c: z.enum(["x", "y"]),
      d: z.array(z.boolean()),
      e: z.preprocess((v) => v, z.string()),
    };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);
    for (const [key, value] of Object.entries(result)) {
      expect(
        (value as any)._zod,
        `${key} is missing _zod (Zod v4 marker)`,
      ).toBeDefined();
    }
  });

  it("converts full ctx_execute-like shape", () => {
    const z3Shape = {
      language: z.enum(["javascript", "typescript", "python", "shell"]),
      code: z.string().describe("Source code"),
      timeout: z.number().optional(),
      background: z.boolean().default(false),
      intent: z.string().optional().describe("Search intent"),
    };
    const result = zod3ShapeToV4(z3Shape as Record<string, unknown>);

    for (const [key, value] of Object.entries(result)) {
      expect(
        (value as any)._zod,
        `${key} is missing _zod`,
      ).toBeDefined();
    }
  });
});
