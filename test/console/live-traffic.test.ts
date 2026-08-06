import { describe, expect, test } from "bun:test";
import { liveTrafficSnapshot, liveTrafficStream } from "../../src/console/api";
import { beginProviderInFlight, endProviderInFlight, incrementInFlight, decrementInFlight, resetInFlightForTests } from "../../src/traffic/in-flight";

describe("console live traffic snapshot", () => {
  test("emits an initial frame and detaches on abort", async () => {
    resetInFlightForTests();
    const controller = new AbortController();
    const response = liveTrafficStream(new Request("http://localhost/console/api/live/in-flight/stream", { signal: controller.signal }), {
      byIp: () => [],
      maxFlightsPerIp: () => 40,
    });
    const reader = response.body?.getReader();
    expect(reader).not.toBeNull();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain("event: count");
    controller.abort();
    await reader?.cancel();
  });

  test("combines global, per-IP, and provider activity", () => {
    resetInFlightForTests();
    incrementInFlight();
    beginProviderInFlight("openai");

    expect(liveTrafficSnapshot({
      byIp: () => [{ ip: "203.0.113.10", active: 1 }],
      maxFlightsPerIp: () => 3,
    })).toEqual({
      inFlight: 1,
      byIp: [{ ip: "203.0.113.10", active: 1 }],
      byProvider: [{ providerId: "openai", active: 1 }],
      maxFlightsPerIp: 3,
    });

    endProviderInFlight("openai");
    decrementInFlight();
    resetInFlightForTests();
  });
});
