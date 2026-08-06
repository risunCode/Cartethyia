import { afterEach, describe, expect, test } from "bun:test";
import { createConsoleLogStreamHub } from "../../src/console/streams";
import type { ConsoleLogStreamSource } from "../../src/console/streams";
import type { ConsoleLogRow } from "../../src/storage";

let hubs: Array<{ close(): void }> = [];
afterEach(() => {
  for (const hub of hubs) hub.close();
  hubs = [];
});

function row(id: number, msg = `m${id}`): ConsoleLogRow {
  // ConsoleLogRow.ts is a string timestamp; ids are loosely ordered ISO ms.
  return { id, ts: String(1_700_000_000_000 + id), level: "info", scope: "test", msg };
}

function track(hub: { close(): void }): void {
  hubs.push(hub);
}

// Reads one SSE frame from a reader the caller owns for the whole test.
// Structural read() signature accepts both the DOM and node:stream/web readers.
async function readFrom(reader: { read(): Promise<{ done: boolean; value: Uint8Array | undefined }> }): Promise<string | null> {
  const result = await reader.read();
  return result.done ? null : new TextDecoder().decode(result.value);
}

function makeSource(rows: readonly ConsoleLogRow[] = [row(2, "world"), row(1, "hello")]): ConsoleLogStreamSource {
  return { latest: (limit) => rows.slice(0, limit), after: () => [] };
}

describe("createConsoleLogStreamHub", () => {
  test("returns an SSE response with the init snapshot in the first frame", async () => {
    const hub = createConsoleLogStreamHub(makeSource());
    track(hub);
    const response = hub.handle(new Request("http://localhost/stream"));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const frame = await readFrom(reader);
    expect(frame).toContain("event: init");
    // newest-first: the first (newest) row id becomes the watermark
    expect(frame).toContain('"msg":"world"');
    expect(frame).toContain('"lastId":2');
    await reader.cancel();
  });

  test("starts with zero clients", () => {
    const hub = createConsoleLogStreamHub(makeSource());
    track(hub);
    expect(hub.activeClients).toBe(0);
  });

  test("broadcastClear is a no-op when no clients are attached", () => {
    const hub = createConsoleLogStreamHub(makeSource());
    track(hub);
    expect(() => hub.broadcastClear()).not.toThrow();
  });

  test("emits a clear frame to an attached client after broadcastClear", async () => {
    const source = makeSource([row(5)]);
    const hub = createConsoleLogStreamHub(source);
    track(hub);
    const response = hub.handle(new Request("http://localhost/stream"));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await readFrom(reader); // consume init
    hub.broadcastClear();
    const frame = await readFrom(reader);
    expect(frame).toContain("event: clear");
    await reader.cancel();
  });

  test("aborted requests detach immediately without keeping a client", async () => {
    const controller = new AbortController();
    controller.abort();
    const hub = createConsoleLogStreamHub(makeSource());
    track(hub);
    const response = hub.handle(new Request("http://localhost/stream", { signal: controller.signal }));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const chunk = await reader.read();
    expect(chunk.done).toBe(true);
  });

  test("close() marks every attached client closed and can be called repeatedly", async () => {
    const hub = createConsoleLogStreamHub(makeSource());
    const response = hub.handle(new Request("http://localhost/stream"));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await readFrom(reader); // trigger start() so the client registers
    expect(hub.activeClients).toBeGreaterThanOrEqual(1);
    hub.close();
    hub.close();
    expect(hub.activeClients).toBe(0);
    await reader.cancel();
  });
});
