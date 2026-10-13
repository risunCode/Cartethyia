import { expect, test } from "bun:test";
import { ProxyRequestStateStore } from "../../src/transport/request/state";

test("in-flight snapshot tracks requests and distinct client IPs until cleanup", () => {
  const store = new ProxyRequestStateStore();
  const first = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 60_000);
  const second = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 60_000);
  first.clientIdentity = { address: "192.0.2.1", source: "tcp-peer" };
  second.clientIdentity = { address: "192.0.2.1", source: "tcp-peer" };

  first.startProviderFlight();
  second.startProviderFlight();
  expect(store.inFlightSnapshot()).toEqual({ inFlight: 2, uniqueIps: 1 });

  first.cleanup();
  expect(store.inFlightSnapshot()).toEqual({ inFlight: 1, uniqueIps: 1 });

  second.cleanup();
  expect(store.inFlightSnapshot()).toEqual({ inFlight: 0, uniqueIps: 0 });
});
