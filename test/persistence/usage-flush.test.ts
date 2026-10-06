import { expect, test } from "bun:test";
import { UsageFlushBuffer } from "../../src/persistence/usage-flush";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";

/** Records writes and fails for ids in `failing`, so the buffer's retry is observable. */
function recordingWrite(failing: Set<string> = new Set()) {
  const calls: Array<{ id: string; delta: number }> = [];
  const write = async (_db: CartethyiaDatabase, id: string, delta: number): Promise<void> => {
    if (failing.has(id)) throw new Error("write failed");
    calls.push({ id, delta });
  };
  return { calls, write };
}

const db = {} as CartethyiaDatabase;

test("coalesces many deltas for one key into a single update", async () => {
  const { calls, write } = recordingWrite();
  const buffer = new UsageFlushBuffer(db, 60_000, write);
  buffer.enqueue("key-1", 10);
  buffer.enqueue("key-1", 5);
  buffer.enqueue("key-2", 3);
  await buffer.flush();
  await buffer.stop();
  expect(calls).toHaveLength(2);
  expect(calls.find((call) => call.id === "key-1")?.delta).toBe(15);
  expect(calls.find((call) => call.id === "key-2")?.delta).toBe(3);
});

test("ignores non-positive deltas", async () => {
  const { calls, write } = recordingWrite();
  const buffer = new UsageFlushBuffer(db, 60_000, write);
  buffer.enqueue("key-1", 0);
  buffer.enqueue("key-1", -4);
  buffer.enqueue("key-1", Number.NaN);
  await buffer.flush();
  await buffer.stop();
  expect(calls).toHaveLength(0);
});

test("retries a key whose write failed and keeps deltas enqueued during the failure", async () => {
  const failing = new Set(["key-1"]);
  const { calls, write } = recordingWrite(failing);
  const buffer = new UsageFlushBuffer(db, 60_000, write);
  buffer.enqueue("key-1", 7);
  buffer.enqueue("key-2", 2);
  await buffer.flush();
  expect(calls.map((call) => call.id)).toEqual(["key-2"]);
  buffer.enqueue("key-1", 1);
  failing.delete("key-1");
  await buffer.flush();
  await buffer.stop();
  expect(calls.find((call) => call.id === "key-1")?.delta).toBe(8);
});
