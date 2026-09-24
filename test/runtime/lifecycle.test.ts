import { describe, expect, test } from "bun:test";
import { ShutdownCoordinator } from "../../src/runtime/lifecycle";
import { ProxyRequestStateStore } from "../../src/transport/request/state";

describe("shutdown abort ordering", () => {
  test("abortAll aborts every tracked controller", () => {
    const store = new ProxyRequestStateStore();
    const first = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const second = new Request("https://gateway.test/v1/responses", { method: "POST" });
    const firstState = store.initialize(first, Date.now(), 60_000);
    const secondState = store.initialize(second, Date.now(), 60_000);
    expect(store.activeCount()).toBe(2);

    store.abortAll();

    expect(firstState.abortController.signal.aborted).toBe(true);
    expect(secondState.abortController.signal.aborted).toBe(true);
    // Teardown is `cleanup()` — `abortAll()` signals, the owner cleans up.
    firstState.cleanup();
    secondState.cleanup();
    expect(store.activeCount()).toBe(0);
  });

  test("coordinator aborts in-flight before flushing telemetry", async () => {
    const order: string[] = [];
    const coordinator = new ShutdownCoordinator(
      {
        flushTelemetry: async () => {
          order.push("flush");
        },
        closePools: async () => {
          order.push("close");
        },
      },
      { drainTimeoutMs: 50, flushTimeoutMs: 50 },
    );
    coordinator.setAbortInflight(() => {
      order.push("abort");
    });

    await coordinator.begin("SIGTERM");

    expect(order).toEqual(["abort", "flush", "close"]);
  });
});