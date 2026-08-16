import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { closeAllSSEConnections, getSSEConnectionPoolStatus, useSSE } from "../../src/lib/sse";
import { login, logout } from "../../src/lib/store";

type SSEHook = ReturnType<typeof useSSE>;
type SSEOptions = Parameters<typeof useSSE>[1];

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }
}

const rootDisposes: Array<() => void> = [];

function mountSSE(url: string, options: SSEOptions = {}): { hook: SSEHook; dispose: () => void } {
  let hook!: SSEHook;
  const dispose = createRoot((rootDispose) => {
    hook = useSSE(url, options);
    return rootDispose;
  });
  // Track every root so afterEach can tear the hook down; otherwise a later
  // login()/logout() changing userSession re-runs the still-live connect
  // effect and recreates connections mid-test.
  rootDisposes.push(dispose);
  return { hook, dispose };
}

describe("useSSE", () => {
  beforeEach(() => {
    FakeEventSource.reset();
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    while (rootDisposes.length > 0) rootDisposes.pop()?.();
    closeAllSSEConnections();
    localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("connects on mount and parses JSON messages", () => {
    const onMessage = vi.fn();
    const { hook } = mountSSE("/console/logs/stream", { onMessage });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/console/logs/stream");
    expect(hook.state()).toEqual({ connected: false, reconnecting: false, error: null });

    const source = FakeEventSource.instances[0];
    source.onopen?.();
    expect(hook.state()).toEqual({ connected: true, reconnecting: false, error: null });

    source.onmessage?.({ data: JSON.stringify({ type: "log", data: { level: "info" } }) });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ type: "log", data: { level: "info" } });
  });

  test("routes malformed message payloads through onError", () => {
    const onMessage = vi.fn();
    const onError = vi.fn();
    mountSSE("/stream", { onMessage, onError });

    FakeEventSource.instances[0].onmessage?.({ data: "{not-json" });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  test("schedules reconnects with exponential backoff", () => {
    vi.useFakeTimers();
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const { hook } = mountSSE("/stream", { reconnectInterval: 1_000, onConnect, onDisconnect });

    const source = FakeEventSource.instances[0];
    source.onopen?.();
    expect(onConnect).toHaveBeenCalledTimes(1);

    source.onerror?.(new Event("error"));
    expect(hook.state()).toMatchObject({ connected: false, reconnecting: true, error: "Connection failed" });
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(999);
    expect(hook.state().connected).toBe(false);

    vi.advanceTimersByTime(1);
    expect(hook.state().connected).toBe(true);
    expect(onConnect).toHaveBeenCalledTimes(2);

    source.onerror?.(new Event("error"));
    vi.advanceTimersByTime(1_999);
    expect(hook.state().connected).toBe(false);

    vi.advanceTimersByTime(1);
    expect(hook.state().connected).toBe(true);
  });

  test("gives up once maxReconnectAttempts is exhausted", () => {
    vi.useFakeTimers();
    const { hook } = mountSSE("/stream", { reconnectInterval: 100, maxReconnectAttempts: 2 });

    const source = FakeEventSource.instances[0];
    // Two failures stay within the retry budget and reconnect.
    source.onerror?.(new Event("error"));
    vi.advanceTimersByTime(100);
    expect(hook.state().connected).toBe(true);

    source.onerror?.(new Event("error"));
    vi.advanceTimersByTime(200);
    expect(hook.state().connected).toBe(true);

    // The third failure exceeds the budget: no reconnect is ever scheduled.
    source.onerror?.(new Event("error"));
    vi.advanceTimersByTime(30_000);
    expect(hook.state().connected).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  test("caps the backoff interval at thirty seconds", () => {
    vi.useFakeTimers();
    const { hook } = mountSSE("/stream", { reconnectInterval: 10_000 });

    const source = FakeEventSource.instances[0];
    source.onerror?.(new Event("error"));
    vi.advanceTimersByTime(10_000); // attempt 1 fires, reconnects
    expect(hook.state().connected).toBe(true);

    source.onerror?.(new Event("error"));
    vi.advanceTimersByTime(20_000); // attempt 2 doubles the wait
    expect(hook.state().connected).toBe(true);

    source.onerror?.(new Event("error"));
    vi.advanceTimersByTime(29_999); // attempt 3 would want 40s, capped at 30s
    expect(hook.state().connected).toBe(false);

    vi.advanceTimersByTime(1);
    expect(hook.state().connected).toBe(true);
  });

  test("keeps the stream URL untouched (cookie-only auth)", () => {
    login("tok-123", { name: "Operator" });
    try {
      mountSSE("/stream", {});
      mountSSE("/stream?since=1", {});

      expect(FakeEventSource.instances[0].url).toBe("/stream");
      expect(FakeEventSource.instances[1].url).toBe("/stream?since=1");
    } finally {
      logout();
    }
  });

  test("reuses a pooled connection instead of opening a second one per URL", () => {
    const onConnectA = vi.fn();
    const onConnectB = vi.fn();
    const a = mountSSE("/shared", { onConnect: onConnectA });
    const b = mountSSE("/shared", { onConnect: onConnectB });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(b.hook.state().connected).toBe(true);
    expect(onConnectA).not.toHaveBeenCalled();
    expect(onConnectB).toHaveBeenCalledTimes(1);

    const source = FakeEventSource.instances[0];
    source.readyState = FakeEventSource.OPEN;
    expect(getSSEConnectionPoolStatus()).toEqual([{ url: "/shared", connected: true }]);

    a.dispose();
    expect(source.closed).toBe(true);
    expect(getSSEConnectionPoolStatus()).toEqual([]);
  });

  test("disconnect closes the source, cancels pending reconnects, and empties the pool", () => {
    vi.useFakeTimers();
    const onDisconnect = vi.fn();
    const { hook } = mountSSE("/solo", { onDisconnect });

    const source = FakeEventSource.instances[0];
    source.onerror?.(new Event("error"));
    expect(hook.state().reconnecting).toBe(true);

    hook.disconnect();

    expect(source.closed).toBe(true);
    expect(getSSEConnectionPoolStatus()).toEqual([]);
    expect(hook.state()).toMatchObject({ connected: false, reconnecting: false });
    // Once from the stream error, once from the explicit disconnect.
    expect(onDisconnect).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  test("disposing the reactive root cleans the connection up like an unmount", () => {
    const { dispose } = mountSSE("/unmount", {});

    dispose();

    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(getSSEConnectionPoolStatus()).toEqual([]);
  });

  test("closeAllSSEConnections closes every pooled stream", () => {
    mountSSE("/one", {});
    mountSSE("/two", {});

    expect(FakeEventSource.instances).toHaveLength(2);

    closeAllSSEConnections();

    expect(FakeEventSource.instances.map((source) => source.closed)).toEqual([true, true]);
    expect(getSSEConnectionPoolStatus()).toEqual([]);
  });
});
