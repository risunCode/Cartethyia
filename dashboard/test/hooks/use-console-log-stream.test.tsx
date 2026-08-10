import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useConsoleLogStream, type ConsoleLogLine } from "../../src/hooks/use-console-log-stream";

class FakeEventSource {
  static instance: FakeEventSource | null = null;
  static closeCount = 0;

  readonly url: string;
  readonly withCredentials: boolean;
  closed = false;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();

  constructor(url: string, options?: EventSourceInit) {
    this.url = url;
    this.withCredentials = options?.withCredentials ?? false;
    FakeEventSource.instance = this;
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    FakeEventSource.closeCount += 1;
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

function makeLine(id: number): ConsoleLogLine {
  return { id, ts: `2026-08-10T00:00:0${id}Z`, level: "info", scope: "test", category: "system", msg: `line ${id}` };
}

function Probe({ category = "request" }: { category?: "all" | "web" | "request" | "system" }): ReactElement {
  const { lines, newLineIds, status, attempts } = useConsoleLogStream(category);
  return <output role="status">{JSON.stringify({ status, attempts, ids: lines.map((line) => line.id), newIds: [...newLineIds] })}</output>;
}

describe("useConsoleLogStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.instance = null;
    FakeEventSource.closeCount = 0;
  });

  test("loads the snapshot, ignores stale lines, batches new lines, and clears", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<Probe category="request" />);

    await waitFor(() => expect(FakeEventSource.instance?.url).toBe("/console/api/console-logs/stream?category=request"));
    expect(FakeEventSource.instance?.withCredentials).toBe(true);

    FakeEventSource.instance?.emit("init", { lines: [makeLine(1), makeLine(2)], lastId: 2 });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent('"status":"connected"'));
    expect(screen.getByRole("status")).toHaveTextContent('"ids":[1,2]');

    FakeEventSource.instance?.emit("line", makeLine(2));
    FakeEventSource.instance?.emit("line", makeLine(3));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent('"ids":[3,1,2]'));
    expect(screen.getByRole("status")).toHaveTextContent('"newIds":[3]');

    FakeEventSource.instance?.emit("clear", null);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent('"ids":[]'));
    expect(screen.getByRole("status")).toHaveTextContent('"newIds":[]');
  });

  test("closes the EventSource when the consumer unmounts", async () => {
    FakeEventSource.closeCount = 0;
    vi.stubGlobal("EventSource", FakeEventSource);
    const view = render(<Probe />);
    await waitFor(() => expect(FakeEventSource.instance).not.toBeNull());
    expect(FakeEventSource.instance?.url).toBe("/console/api/console-logs/stream?category=request");

    view.unmount();

    expect(FakeEventSource.closeCount).toBe(1);
  });
});
