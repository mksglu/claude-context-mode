/**
 * db-write-queue + ContentStore.closeImmediate — write serialization tests.
 *
 * The queue serializes synchronous SQLite writes against a single DB path
 * inside one process so concurrent index() / cleanupStaleSources() calls do
 * not race. The `closeImmediate()` path provides a synchronous shutdown that
 * `process.on("exit")` can use (it cannot await).
 */

import { describe, test, expect } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ContentStore } from "../src/store.js";
import { enqueueDbWrite, flushDbWriteQueue } from "../src/db-write-queue.js";

function freshPath(tag: string): string {
  return join(
    tmpdir(),
    `context-mode-queue-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanupPath(p: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(p + suffix); } catch { /* ignore */ }
  }
}

describe("enqueueDbWrite — single-dbPath serialization", () => {
  test("two parallel writes through enqueueDbWrite are serialized", async () => {
    const path = freshPath("serialize");
    const events: string[] = [];

    // Both tasks share the same dbPath, so the queue must run them in order.
    // The second one must NOT observe `running=true` when it starts.
    let running = false;

    const t1 = enqueueDbWrite(path, () => {
      expect(running).toBe(false);
      running = true;
      events.push("t1-start");
      // Synchronous busy work — block briefly so an unserialized t2 would
      // otherwise observe `running=true` if it ran in parallel.
      const end = Date.now() + 25;
      while (Date.now() < end) { /* spin */ }
      events.push("t1-end");
      running = false;
      return "t1";
    });

    const t2 = enqueueDbWrite(path, () => {
      expect(running).toBe(false);
      running = true;
      events.push("t2-start");
      events.push("t2-end");
      running = false;
      return "t2";
    });

    const [r1, r2] = await Promise.all([t1, t2]);
    expect(r1).toBe("t1");
    expect(r2).toBe("t2");
    expect(events).toEqual(["t1-start", "t1-end", "t2-start", "t2-end"]);
  });

  test("a failing task does not poison the queue for the next caller", async () => {
    const path = freshPath("poison");
    const t1 = enqueueDbWrite(path, () => { throw new Error("boom"); });
    await expect(t1).rejects.toThrow("boom");
    const t2 = await enqueueDbWrite(path, () => "ok");
    expect(t2).toBe("ok");
  });

  test("writes on different dbPaths run independently", async () => {
    const pathA = freshPath("indep-a");
    const pathB = freshPath("indep-b");

    let resolveA: (v: string) => void;
    const aGate = new Promise<string>((res) => { resolveA = res; });

    const a = enqueueDbWrite(pathA, async () => {
      await aGate;
      return "a";
    });
    // pathB is unrelated — it should resolve immediately without waiting on pathA.
    const b = await enqueueDbWrite(pathB, () => "b");
    expect(b).toBe("b");

    resolveA!("a");
    expect(await a).toBe("a");
  });
});

describe("ContentStore + enqueueDbWrite — concurrent indexing + cleanup", () => {
  test("cleanupStaleSources queued alongside heavy indexQueued does not raise SQLITE_BUSY", async () => {
    const path = freshPath("heavy");
    const store = new ContentStore(path);
    try {
      const big = "# Doc\n" + Array.from({ length: 500 }, (_, i) => `paragraph ${i} word${i} content${i}`).join("\n\n");

      // Kick off many index() calls plus a cleanupStaleSources via the queue.
      // All tasks bound to the same dbPath — they must serialize, NOT throw.
      const tasks: Promise<unknown>[] = [];
      for (let i = 0; i < 8; i++) {
        tasks.push(enqueueDbWrite(store.dbPath, () => store.index({ content: big, source: `heavy-${i}` })));
      }
      tasks.push(enqueueDbWrite(store.dbPath, () => store.cleanupStaleSources(14)));
      for (let i = 8; i < 16; i++) {
        tasks.push(enqueueDbWrite(store.dbPath, () => store.index({ content: big, source: `heavy-${i}` })));
      }

      const results = await Promise.allSettled(tasks);
      for (const r of results) {
        if (r.status === "rejected") {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          // Specifically: nothing should surface as SQLITE_BUSY.
          expect(msg).not.toMatch(/SQLITE_BUSY|database is locked/);
        }
      }
      // All tasks should have actually completed.
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    } finally {
      store.closeImmediate();
      cleanupPath(path);
    }
  });
});

describe("gracefulShutdown-style flow", () => {
  test("flushDbWriteQueue resolves only after queued writes complete", async () => {
    const path = freshPath("flush");
    const store = new ContentStore(path);
    try {
      const order: string[] = [];

      // Enqueue a write that records its completion order.
      enqueueDbWrite(store.dbPath, () => {
        store.index({ content: "# Title\nbody body body", source: "flushed" });
        order.push("write-done");
      }).catch(() => { /* swallow for the test */ });

      // flushDbWriteQueue must wait for the queued write before resolving.
      await flushDbWriteQueue(store.dbPath);
      order.push("flush-resolved");

      expect(order).toEqual(["write-done", "flush-resolved"]);

      // After flush, the indexed source must actually be persisted.
      const meta = store.getSourceMeta("flushed");
      expect(meta).not.toBeNull();
      expect(meta!.label).toBe("flushed");
    } finally {
      store.closeImmediate();
      cleanupPath(path);
    }
  });

  test("flushDbWriteQueue on a never-touched dbPath resolves immediately", async () => {
    const path = freshPath("noop");
    // The queue has no tail for this dbPath, so flush must resolve without throwing.
    await expect(flushDbWriteQueue(path)).resolves.toBeUndefined();
  });
});

describe("closeImmediate — synchronous shutdown", () => {
  test("closeImmediate does not hang and does not need an active microtask flush", () => {
    const path = freshPath("close-imm");
    const store = new ContentStore(path);
    store.index({ content: "# X\nbody", source: "close-test" });

    const start = Date.now();
    // No await, no enqueue — purely synchronous.
    store.closeImmediate();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);

    cleanupPath(path);
  });

  test("closeImmediate is idempotent (matches close())", () => {
    const path = freshPath("close-imm-idemp");
    const store = new ContentStore(path);
    store.closeImmediate();
    expect(() => store.closeImmediate()).not.toThrow();
    cleanupPath(path);
  });

  test("after closeImmediate, data is persisted (reopen sees indexed source)", () => {
    const path = freshPath("close-imm-persist");
    const store1 = new ContentStore(path);
    store1.index({ content: "# Saved\nstuff", source: "persisted-via-immediate" });
    store1.closeImmediate();

    const store2 = new ContentStore(path);
    const meta = store2.getSourceMeta("persisted-via-immediate");
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe("persisted-via-immediate");
    store2.closeImmediate();

    cleanupPath(path);
  });
});

describe("ContentStore.dbPath getter", () => {
  test("exposes the underlying SQLite file path", () => {
    const path = freshPath("dbpath-getter");
    const store = new ContentStore(path);
    try {
      expect(store.dbPath).toBe(path);
    } finally {
      store.closeImmediate();
      cleanupPath(path);
    }
  });
});
