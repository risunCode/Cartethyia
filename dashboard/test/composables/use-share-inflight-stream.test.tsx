import { render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  parseShareInFlightPayload,
  resolveShareInFlight,
  useShareInFlightStream,
} from "../../src/composables/observability/use-inflight-stream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly options: EventSourceInit | undefined;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();

  constructor(url: string, options?: EventSourceInit) {
    this.url = url;
    this.options = options;
    FakeEventSource.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void);
  }

  close(): void {
    this.closed = true;
  }

  emitError(): void {
    this.onerror?.();
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

function Probe(props: { token: string | null; enabled?: boolean }) {
  const snapshot = useShareInFlightStream(props.token, props.enabled);
  return <output role="status">{`${snapshot().connectionStatus}:${snapshot().inFlight ?? "fallback"}`}</output>;
}

describe("useShareInFlightStream", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  test("defensively parses only a non-negative integer inFlight count", () => {
    expect(parseShareInFlightPayload('{"inFlight":4,"byIp":[{"ip":"secret","active":4}]}')).toBe(4);
    expect(parseShareInFlightPayload({ inFlight: 0 })).toBe(0);
    expect(parseShareInFlightPayload("not json")).toBeNull();
    expect(parseShareInFlightPayload('{"inFlight":-1}')).toBeNull();
    expect(parseShareInFlightPayload('{"inFlight":1.5}')).toBeNull();
    expect(parseShareInFlightPayload('{"inFlight":"4"}')).toBeNull();
  });

  test("keeps the polling count while the public stream is not live", () => {
    expect(resolveShareInFlight({ inFlight: null, connectionStatus: "connecting" }, 7)).toBe(7);
    expect(resolveShareInFlight({ inFlight: 3, connectionStatus: "error" }, 7)).toBe(7);
    expect(resolveShareInFlight({ inFlight: 3, connectionStatus: "connected" }, 7)).toBe(3);
  });

  test("uses the token stream, coalesces valid count events, and ignores malformed events", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(() => <Probe token="public-token" />);
    await waitFor(() => expect(FakeEventSource.instances[0]?.url).toBe("/share/public-token/stream"));
    expect(FakeEventSource.instances[0]?.options).toEqual({ withCredentials: false });

    const source = FakeEventSource.instances[0];
    source?.emit("count", { inFlight: 2, byIp: [{ ip: "private", active: 2 }] });
    source?.emit("count", { inFlight: 5 });
    source?.emit("count", { inFlight: "bad" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("connected:5"));
  });

  test("reconnects with bounded backoff and closes on cleanup", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const view = render(() => <Probe token="retry-token" />);
    await vi.runOnlyPendingTimersAsync();
    expect(FakeEventSource.instances).toHaveLength(1);

    FakeEventSource.instances[0]?.emitError();
    expect(screen.getByRole("status")).toHaveTextContent("error:fallback");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeEventSource.instances).toHaveLength(2);

    view.unmount();
    expect(FakeEventSource.instances[1]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  test("drops the stale live count when the stream errors", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(() => <Probe token="fallback-token" />);
    await waitFor(() => expect(FakeEventSource.instances[0]).toBeDefined());
    const source = FakeEventSource.instances[0];
    source?.emit("count", { inFlight: 9 });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("connected:9"));

    source?.emitError();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("error:fallback"));
  });

  test("does not open a stream when disabled for setup or preview", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const view = render(() => <>
      <Probe token={null} enabled={false} />
      <Probe token="preview-token" enabled={false} />
    </>);

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("disabled:fallback");
    view.unmount();
  });
});

