/**
 * Zod 3 → Zod 4 shape conversion (KiloCode only).
 *
 * KiloCode's runtime bundles Zod v4 internally. When it receives plugin tool
 * definitions whose `args` contain Zod v3 schemas (with `_def` but no `_zod`),
 * it crashes with `undefined is not an object (evaluating 'n._zod.def')`.
 *
 * This module converts Zod 3 schema shapes into Zod 4 equivalents so KiloCode
 * can process them natively. Only called when `platform === "kilo"`.
 * OpenCode uses Zod 3 natively and receives the original shapes unchanged.
 */
import z from 'zod/v4';

export function zod3ShapeToV4(shape: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(shape)) {
    result[key] = zod3ToV4(value, depth);
  }
  return result;
}

function zod3ToV4(v: unknown, depth = 0): z.ZodType {
  if (depth > 10) return z.unknown();
  if (v == null || typeof v !== "object") return z.unknown();

  const obj = v as Record<string, unknown>;
  if (!obj._def || typeof obj._def !== "object") return z.unknown();

  const def = obj._def as Record<string, unknown>;

  let result: z.ZodType;

  switch (def.typeName) {
    case "ZodString":
      result = z.string();
      break;

    case "ZodNumber":
      result = z.number();
      break;

    case "ZodBoolean":
      result = z.boolean();
      break;

    case "ZodAny":
      result = z.any();
      break;

    case "ZodUnknown":
      result = z.unknown();
      break;

    case "ZodNever":
      result = z.never();
      break;

    case "ZodNull":
      result = z.null();
      break;

    case "ZodUndefined":
      result = z.undefined();
      break;

    case "ZodLiteral":
      result = z.literal(def.value as string | number | boolean | null);
      break;

    case "ZodArray":
      result = z.array(zod3ToV4(def.type ?? def.elementType, depth + 1));
      break;

    case "ZodEnum": {
      const values = def.values;
      result = Array.isArray(values) && values.length > 0
        ? z.enum(values as [string, ...string[]])
        : z.never();
      break;
    }

    case "ZodObject": {
      const raw = def.shape as Record<string, unknown> | (() => Record<string, unknown>) | undefined;
      const inner = typeof raw === "function" ? raw() : raw;
      result = z.object(inner ? zod3ShapeToV4(inner, depth + 1) as Record<string, z.ZodType> : {});
      break;
    }

    case "ZodOptional":
      result = z.optional(zod3ToV4(def.innerType ?? def.type, depth + 1));
      break;

    case "ZodNullable":
      result = z.nullable(zod3ToV4(def.innerType ?? def.type, depth + 1));
      break;

    case "ZodDefault": {
      const val = typeof def.defaultValue === "function"
        ? (def.defaultValue as () => unknown)()
        : def.defaultValue;
      result = zod3ToV4(def.innerType ?? def.type, depth + 1).default(val);
      break;
    }

    case "ZodRecord":
      result = z.record(z.string(), zod3ToV4(def.valueType, depth + 1));
      break;

    case "ZodUnion": {
      const opts = def.options as unknown[] | undefined;
      if (!opts || opts.length === 0) return z.never();
      if (opts.length === 1) return zod3ToV4(opts[0], depth + 1);
      result = z.union(opts.map(o => zod3ToV4(o, depth + 1)) as [z.ZodType, z.ZodType, ...z.ZodType[]]);
      break;
    }

    case "ZodEffects":
      // Host schema only. Original Zod 3 schema still parses in execute().
      result = zod3ToV4(def.schema, depth + 1);
      break;

    default:
      // Never leak raw Zod 3 schemas back to KiloCode.
      result = z.unknown();
      break;
  }

  return def.description && typeof result.describe === "function"
    ? result.describe(String(def.description))
    : result;
}