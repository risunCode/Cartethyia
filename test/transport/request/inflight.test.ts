import { beforeEach, describe, expect, test } from "bun:test";
import {
  decrementInFlight,
  getInFlightCount,
  incrementInFlight,
  resetInFlightForTests,
  subscribeInFlight,
} from "../../../src/transport/request/inflight";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";

describe("in-flight counter", () => {
  beforeEach(() => resetInFlightForTests());

  test("starts at zero and tracks increments", () => {
    expect(getInFlightCount()).toBe(0);
    incrementInFlight();
    incrementInFlight();
    expect(getInFlightCount()).toBe(2);
  });

  test("decrement floors at zero instead of going negative", () => {
    decrementInFlight();
    expect(getInFlightCount()).toBe(0);
    incrementInFlight();
    decrementInFlight();
    decrementInFlight();
    expect(getInFlightCount()).toBe(0);
  });

  test("notifies subscribers on every change and unsubscribes cleanly", () => {
    const seen: number[] = [];
    const unsubscribe = subscribeInFlight((count) => void seen.push(count));
    incrementInFlight();
    decrementInFlight();
    unsubscribe();
    incrementInFlight();
    expect(seen).toEqual([1, 0]);
    expect(getInFlightCount()).toBe(1);
  });
});

describe("request state store in-flight funnel", () => {
  beforeEach(() => resetInFlightForTests());

  test("initialize admits exactly one flight; cleanup releases exactly once", () => {
    const store = new ProxyRequestStateStore();
    const state = store.initialize(new Request("https://gateway.test/v1/chat/completions"), Date.now(), 60_000);
    expect(getInFlightCount()).toBe(1);
    state.cleanup();
    expect(getInFlightCount()).toBe(0);
    state.cleanup();
    expect(getInFlightCount()).toBe(0);
  });
});
