import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enqueueDbWrite, getDbWriteQueueDepthForTest } from "../../src/db-write-queue.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dbPath(name: string): string {
  return join(tmpdir(), `context-mode-queue-${process.pid}-${name}.db`);
}

describe("enqueueDbWrite", () => {
  test("serializes jobs FIFO per DB path", async () => {
    const events: string[] = [];
    const path = dbPath("fifo");

    const first = enqueueDbWrite(path, async () => {
      events.push("first:start");
      await delay(20);
      events.push("first:end");
      return 1;
    });
    const second = enqueueDbWrite(path, () => {
      events.push("second");
      return 2;
    });

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  test("runs independent DB paths independently", async () => {
    const events: string[] = [];
    const slow = enqueueDbWrite(dbPath("slow"), async () => {
      events.push("slow:start");
      await delay(30);
      events.push("slow:end");
    });

    await delay(0);
    await enqueueDbWrite(dbPath("fast"), () => {
      events.push("fast");
    });
    await slow;

    expect(events).toEqual(["slow:start", "fast", "slow:end"]);
  });

  test("rejected jobs do not block later jobs", async () => {
    const path = dbPath("reject");
    await expect(enqueueDbWrite(path, () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");

    await expect(enqueueDbWrite(path, () => "after")).resolves.toBe("after");
    await delay(0);
    expect(getDbWriteQueueDepthForTest()).toBe(0);
  });
});
