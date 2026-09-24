import { describe, expect, test } from "bun:test";
import { consoleSseResponse, createConsoleSseStream, formatSseFrame } from "../../../../src/console/domains/sse/routes";

describe("console SSE framing", () => {
  test("formats named JSON events", () => {
    expect(formatSseFrame("count", `{"inFlight":3}`)).toBe(`event: count\ndata: {"inFlight":3}\n\n`);
  });

  test("response carries the SSE content type", () => {
    const response = consoleSseResponse(new ReadableStream<Uint8Array>());
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
  });
});

describe("console SSE stream", () => {
  test("emits the setup snapshot, then pushed updates, and cleans up on cancel", async () => {
    const tornDown: string[] = [];
    const controller = new AbortController();
    const stream = createConsoleSseStream(controller.signal, ({ send }) => {
      send("count", { inFlight: 2 });
      const timer = setTimeout(() => send("count", { inFlight: 5 }), 5);
      return () => {
        clearTimeout(timer);
        tornDown.push("teardown");
      };
    });

    const reader = stream.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(`event: count\ndata: {"inFlight":2}`);
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain(`{"inFlight":5}`);
    await reader.cancel();
    expect(tornDown).toEqual(["teardown"]);
  });

  test("an already-aborted signal closes without running setup pushes", async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = createConsoleSseStream(controller.signal, ({ send }) => {
      send("count", { inFlight: 1 });
      return () => {};
    });
    const reader = stream.getReader();
    const read = await reader.read();
    expect(read.done).toBe(true);
  });
});
