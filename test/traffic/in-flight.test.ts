import { describe, expect, test } from "bun:test";
import { beginProviderInFlight, endProviderInFlight, getInFlightCount, getProviderInFlight, resetInFlightForTests, subscribeInFlight } from "../../src/traffic/in-flight";

describe("in-flight traffic tracking", () => {
  test("publishes provider activity without losing the global count", async () => {
    resetInFlightForTests();
    const counts: number[] = [];
    const unsubscribe = subscribeInFlight((count) => counts.push(count));

    beginProviderInFlight("openai");
    beginProviderInFlight("openai");
    beginProviderInFlight("anthropic");

    expect(getInFlightCount()).toBe(0);
    expect(getProviderInFlight()).toEqual([
      { providerId: "openai", active: 2 },
      { providerId: "anthropic", active: 1 },
    ]);

    endProviderInFlight("openai");
    endProviderInFlight("openai");
    endProviderInFlight("anthropic");
    expect(getProviderInFlight()).toEqual([]);

    // Notifications are coalesced per microtask: a burst of mutations fires one listener round.
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(counts).toHaveLength(1);

    unsubscribe();
    resetInFlightForTests();
  });
});
