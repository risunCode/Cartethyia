import { afterEach, describe, expect, test } from "bun:test";
import { scheduleGlobalGc, cancelScheduledGc } from "../../src/traffic/memory";
import { decrementInFlight, getInFlightCount, incrementInFlight, resetInFlightForTests } from "../../src/traffic/in-flight";

afterEach(() => {
  cancelScheduledGc();
  resetInFlightForTests();
});

describe("scheduleGlobalGc", () => {
  test("runs a non-blocking GC immediately when no proxy traffic is in flight", () => {
    expect(getInFlightCount()).toBe(0);
    const result = scheduleGlobalGc();
    expect(result).toEqual({ status: "scheduled", inFlight: 0 });
    // scheduleAttempt cleared the pending flag synchronously, so a second
    // request is not treated as a duplicate.
    expect(scheduleGlobalGc()).toEqual({ status: "scheduled", inFlight: 0 });
  });

  test("defers the GC retry when proxy traffic is active", () => {
    incrementInFlight();
    const result = scheduleGlobalGc();
    expect(result.status).toBe("deferred");
    expect(result.inFlight).toBe(1);
  });

  test("reports already_pending while a deferred attempt is queued", () => {
    incrementInFlight();
    scheduleGlobalGc();
    expect(scheduleGlobalGc()).toEqual({ status: "already_pending", inFlight: 1 });
  });

  test("cancelScheduledGc resets the pending flag so a new request can defer again", () => {
    incrementInFlight();
    scheduleGlobalGc();
    expect(scheduleGlobalGc().status).toBe("already_pending");
    cancelScheduledGc();
    expect(scheduleGlobalGc().status).toBe("deferred");
  });

  test("cancelScheduledGc is a no-op when no retry timer is pending", () => {
    expect(() => cancelScheduledGc()).not.toThrow();
    decrementInFlight();
  });
});
