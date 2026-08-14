import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useInFlightSnapshot } from "../../src/composables/observability/use-inflight-stream";

class FakeEventSource {
  static instance: FakeEventSource | null = null;
  static closeCount = 0;
  readonly url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instance = this;
    queueMicrotask(() => this.onopen?.());
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    FakeEventSource.closeCount += 1;
  }

  emitError(): void {
    this.onerror?.();
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

function Probe(): ReactElement {
  const snapshot = useInFlightSnapshot();
  return <output>{`${snapshot.connectionStatus}:${snapshot.inFlight}:${snapshot.byProvider[0]?.providerId ?? "none"}`}</output>;
}

describe("useInFlightSnapshot", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeEventSource.closeCount = 0;
    FakeEventSource.instance = null;
  });

  test("marks the stream as reconnecting after an error", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<Probe />);
    await waitFor(() => expect(FakeEventSource.instance).not.toBeNull());
    FakeEventSource.instance?.emitError();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("error:0:none"));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("connected:0:none"));
  });

  test("connects to the live endpoint and exposes provider activity", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<Probe />);
    await waitFor(() => expect(FakeEventSource.instance?.url).toBe("/console/api/live/in-flight/stream"));

    FakeEventSource.instance?.emit("count", { inFlight: 2, byIp: [{ ip: "203.0.113.10", active: 2 }], byProvider: [{ providerId: "openai", active: 2 }], maxFlightsPerIp: 15 });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("connected:2:openai"));
  });
  test("closes the EventSource when the consumer unmounts", async () => {
    FakeEventSource.closeCount = 0;
    vi.stubGlobal("EventSource", FakeEventSource);
    const view = render(<Probe />);
    await waitFor(() => expect(FakeEventSource.instance).not.toBeNull());

    view.unmount();

    expect(FakeEventSource.closeCount).toBe(1);
  });
});
