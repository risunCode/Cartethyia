import { describe, expect, test } from "bun:test";
import { PerIpFlightTracker } from "../../src/traffic/per-ip";

describe("per-IP in-flight tracking", () => {
  test("returns busiest active IPs and removes released slots", () => {
    const tracker = new PerIpFlightTracker();
    const first = tracker.tryAcquire("203.0.113.10", 3, 1000);
    const second = tracker.tryAcquire("203.0.113.10", 3, 1001);
    const third = tracker.tryAcquire("198.51.100.7", 3, 1002);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
    expect(tracker.snapshot()).toEqual([
      { ip: "203.0.113.10", active: 2 },
      { ip: "198.51.100.7", active: 1 },
    ]);

    second?.release();
    first?.release();
    expect(tracker.snapshot()).toEqual([{ ip: "198.51.100.7", active: 1 }]);
    third?.release();
    expect(tracker.snapshot()).toEqual([]);
  });
});
