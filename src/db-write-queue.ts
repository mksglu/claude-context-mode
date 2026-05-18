import { resolve } from "node:path";

type WriteJob<T> = () => T | Promise<T>;

const tails = new Map<string, Promise<void>>();

function queueKey(dbPath: string): string {
  return resolve(dbPath);
}

/**
 * Serialize write jobs per physical SQLite DB path. Different DB files keep
 * running independently; failures resolve the queue tail so later jobs are not
 * stranded behind a rejected promise.
 */
export function enqueueDbWrite<T>(dbPath: string, job: WriteJob<T>): Promise<T> {
  const key = queueKey(dbPath);
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(job);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );

  tails.set(key, tail);
  tail.finally(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });

  return run;
}

export function getDbWriteQueueDepthForTest(): number {
  return tails.size;
}

/**
 * Resolve once the current tail for `dbPath` has settled. Used by graceful
 * shutdown to flush in-flight writes before closing the database.
 */
export function flushDbWriteQueue(dbPath: string): Promise<void> {
  const tail = tails.get(queueKey(dbPath));
  return tail ? tail.then(() => undefined, () => undefined) : Promise.resolve();
}
