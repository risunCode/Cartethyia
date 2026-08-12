import { afterEach, describe, expect, test, vi } from "bun:test";
import { AbortCoordinator } from "../../src/open-sse/transport/abort-coordinator";
import { executeFetch } from "../../src/open-sse/transport/fetch";

const originalFetch = globalThis.fetch;

function pendingFetch(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});
describe("provider transport timeout phases", () => {
  test("aborts a fetch that never returns response headers", async () => {
    vi.useFakeTimers();
    globalThis.fetch = pendingFetch as unknown as typeof fetch;
    const coordinator = new AbortCoordinator(new AbortController().signal, { firstByteTimeoutMs: 15 });
    const pending = executeFetch("https://upstream.test", {}, coordinator);
    vi.advanceTimersByTime(15);

    await expect(pending).rejects.toMatchObject({
      kind: "network_unavailable",
      message: "Upstream first-byte timeout",
    });
    expect(coordinator.causeOf()).toBe("first_byte_timeout");
    coordinator.dispose();
  });

  test("clears first-byte timeout after headers without cancelling a slow body", async () => {
    vi.useFakeTimers();
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 })) as unknown as typeof fetch;
    const coordinator = new AbortCoordinator(new AbortController().signal, { firstByteTimeoutMs: 15 });

    const response = await executeFetch("https://upstream.test", {}, coordinator);
    vi.advanceTimersByTime(35);

    expect(response.status).toBe(200);
    expect(coordinator.signal.aborted).toBe(false);
    expect(coordinator.causeOf()).toBe("caller");
    coordinator.dispose();
  });

  test("resets idle timeout on each body read window", () => {
    vi.useFakeTimers();
    const coordinator = new AbortCoordinator(new AbortController().signal, { idleTimeoutMs: 25 });
    coordinator.resetIdle();
    vi.advanceTimersByTime(12);
    coordinator.resetIdle();
    vi.advanceTimersByTime(15);
    expect(coordinator.signal.aborted).toBe(false);
    vi.advanceTimersByTime(20);
    expect(coordinator.signal.aborted).toBe(true);
    expect(coordinator.causeOf()).toBe("idle_timeout");
    coordinator.dispose();
  });

  test("keeps total timeout cause distinct while fetch is pending", async () => {
    vi.useFakeTimers();
    globalThis.fetch = pendingFetch as unknown as typeof fetch;
    const coordinator = new AbortCoordinator(new AbortController().signal, { totalTimeoutMs: 15 });
    const pending = executeFetch("https://upstream.test", {}, coordinator);
    vi.advanceTimersByTime(15);

    await expect(pending).rejects.toMatchObject({ kind: "network_unavailable" });
    expect(coordinator.causeOf()).toBe("total_timeout");
    coordinator.dispose();
  });

  test("preserves caller abort precedence over transport timeout", async () => {
    globalThis.fetch = pendingFetch as unknown as typeof fetch;
    const caller = new AbortController();
    const coordinator = new AbortCoordinator(caller.signal, { firstByteTimeoutMs: 50 });
    const pending = executeFetch("https://upstream.test", {}, coordinator);
    caller.abort();

    await expect(pending).rejects.toThrow("Request aborted by caller");
    expect(coordinator.causeOf()).toBe("caller");
    coordinator.dispose();
  });

  test("dispose clears every timer and caller listener", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const coordinator = new AbortCoordinator(caller.signal, { totalTimeoutMs: 15, idleTimeoutMs: 15, firstByteTimeoutMs: 15 });
    coordinator.armFirstByteTimeout();
    coordinator.resetIdle();
    coordinator.dispose();

    vi.advanceTimersByTime(35);
    caller.abort();
    expect(coordinator.signal.aborted).toBe(false);
    expect(coordinator.causeOf()).toBe("caller");
  });

});
