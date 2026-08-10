import { describe, expect, test } from "bun:test";
import { QuotaService } from "../../src/console/services/composition";

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("quota refresh queue", () => {
  test("coalesces duplicate accounts and caps active refreshes", async () => {
    const waiters: Array<() => void> = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const accounts = {
      get: async () => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        const gate = Promise.withResolvers<void>();
        waiters.push(gate.resolve);
        await gate.promise;
        activeCalls -= 1;
        return null;
      },
    };
    const service = new QuotaService(accounts as never, {} as never, {} as never);

    const initial = service.enqueueRefresh(["a", "a", "b", "c", "d", "e"]);
    expect(initial.active).toBe(3);
    expect(initial.queued).toBe(2);
    expect(maxActiveCalls).toBe(3);

    waiters.splice(0, 3).forEach((release) => release());
    await flushMicrotasks();
    expect(service.queueStatus().active).toBe(2);
    expect(service.queueStatus().queued).toBe(0);
    expect(maxActiveCalls).toBe(3);

    waiters.splice(0).forEach((release) => release());
    await flushMicrotasks();
    expect(service.queueStatus().active).toBe(0);
    expect(service.queueStatus().queued).toBe(0);
  });
});
