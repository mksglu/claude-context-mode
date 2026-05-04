import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("enterprise insight route", () => {
  it("keeps the cloud session continuity scenario covered", () => {
    const source = readFileSync(
      resolve(repoRoot, "insight/src/routes/enterprise.tsx"),
      "utf8",
    );

    expect(source).toContain(
      '"I was debugging auth.ts yesterday on my laptop. Now I\'m on my desktop. Where was I?"',
    );
    expect(source).toContain(
      "Cloud sessions. Any device, any time. Full history.",
    );
  });
});
