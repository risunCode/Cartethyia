import { describe, expect, test } from "bun:test";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves true when `signal` aborts before `timeoutMs`, false otherwise. */
function waitForAbort(signal: AbortSignal, timeoutMs = 2_000): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
}

function newState(deadlineMs: number) {
  const store = new ProxyRequestStateStore();
  const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
  return { store, request, state: store.initialize(request, Date.now(), deadlineMs) };
}

describe("ProxyRequestStateStore request identity", () => {
  test("captures method and path at initialization so lifecycle gating never depends on middleware order", () => {
    const store = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions?stream=true", {
      method: "POST",
    });
    const state = store.initialize(request, Date.now(), 30_000);
    expect(state.ingressMethod).toBe("POST");
    // Query string is excluded: the path is the route identity.
    expect(state.ingressPath).toBe("/v1/chat/completions");
    state.cleanup();
  });
});

describe("ProxyRequestStateStore deadline", () => {
  test("aborts the controller when the deadline elapses", async () => {
    const { state } = newState(20);
    expect(await waitForAbort(state.abortController.signal)).toBe(true);
    state.cleanup();
  });

  test("extendDeadline re-arms the timer past the original deadline", async () => {
    const { state } = newState(20);
    state.extendDeadline(500);
    // Well past the original 20ms deadline, the extension keeps it alive.
    await sleep(80);
    expect(state.abortController.signal.aborted).toBe(false);
    expect(await waitForAbort(state.abortController.signal)).toBe(true);
    state.cleanup();
  });

  test("extendDeadline is a no-op after cleanup", async () => {
    const { state } = newState(20);
    state.cleanup();
    // Cleanup already aborted with "request complete"; extending must neither
    // throw nor resurrect the request.
    state.extendDeadline(10_000);
    expect(state.abortController.signal.aborted).toBe(true);
    await sleep(30);
    expect(state.abortController.signal.aborted).toBe(true);
  });
});
