import { vi } from "vitest";

/**
 * Shared helpers for exercising the live dashboard surfaces under jsdom.
 *
 * TanStack Virtual reads `offsetHeight`/`offsetWidth` from the scroll element
 * (jsdom reports 0), so virtualized tables and log panes render zero rows
 * unless the layout is stubbed. `stubVirtualLayout()` makes the virtualizer
 * compute a 600px viewport so row content becomes assertable.
 */
export function stubVirtualLayout(): void {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });
}

/**
 * Minimal EventSource stand-in for `useSSE`-driven components. Mirrors the
 * surface lib/sse.ts touches: constructor URL, onopen/onmessage/onerror, and
 * addEventListener for named event types such as the share stream's "count".
 */
export class FakeEventSource {
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
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: (event: { data: string }) => void): void {
    const current = this.listeners.get(type) ?? [];
    this.listeners.set(type, current.filter((entry) => entry !== listener));
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** Simulates the connection opening. */
  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  /** Simulates a connection failure. */
  fail(): void {
    this.onerror?.(new Event("error"));
  }

  /** Delivers a JSON payload on the default `message` channel. */
  emit(payload: unknown): void {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.onmessage?.({ data });
  }

  /** Delivers a JSON payload on a named event channel (e.g. "count"). */
  emitNamed(type: string, payload: unknown): void {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }
}

/** Installs the fake EventSource globally and silences the SSE error logger. */
export function stubEventSource(): void {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "error").mockImplementation(() => {});
}
