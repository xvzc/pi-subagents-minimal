import { resolve } from "node:path";

/**
 * In-process coordination for record replacement and retention deletion.
 *
 * Keys are absolute record paths. Queued entries are removed after the final
 * waiter releases them, so unrelated paths proceed independently and the map
 * does not retain inactive records. This intentionally cannot coordinate a
 * second Node process; cross-process pathname races require openat-style APIs
 * that Node does not expose.
 */
const recordTails = new Map<string, Promise<void>>();

/** Run one operation exclusively for a record path within this process. */
export async function withRecordStorageLock<T>(
  recordPath: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const key = resolve(recordPath);
  const previous = recordTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  recordTails.set(key, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (recordTails.get(key) === current) recordTails.delete(key);
  }
}
