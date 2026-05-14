import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContentStore } from "../src/store.js";

describe("ContentStore queued writes", () => {
  test("concurrent queued index calls from two instances complete on one DB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-mode-store-queue-"));
    const dbPath = join(dir, "content.db");
    const a = new ContentStore(dbPath);
    const b = new ContentStore(dbPath);

    try {
      await Promise.all([
        a.indexQueued({ content: "# Alpha\n\nalpha queued write", source: "alpha-doc" }),
        b.indexQueued({ content: "# Beta\n\nbeta queued write", source: "beta-doc" }),
      ]);

      const alpha = a.searchWithFallback("alpha", 5, "alpha-doc", undefined, "exact");
      const beta = b.searchWithFallback("beta", 5, "beta-doc", undefined, "exact");
      expect(alpha.map((r) => r.source)).toContain("alpha-doc");
      expect(beta.map((r) => r.source)).toContain("beta-doc");
    } finally {
      try { a.close(); } catch { /* ignore */ }
      try { b.close(); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
