import { expect, test } from "bun:test";
import {
  classifyPoolConnectError,
  classifyPoolProbeResponse,
} from "../../../../src/console/routing/pools/probe-result";

test("HTTP 402 is reachable but reports a payment failure", () => {
  expect(classifyPoolProbeResponse("pool-1", { ok: false, status: 402 }, 12)).toEqual({
    poolId: "pool-1",
    status: "reachable",
    httpStatus: 402,
    latencyMs: 12,
    errorMessage: "Proxy reachable — HTTP 402 Payment Required",
  });
});

test("HTTP 407 is reachable but reports a proxy authentication failure", () => {
  expect(classifyPoolProbeResponse("pool-1", { ok: false, status: 407 }, 12)).toEqual({
    poolId: "pool-1",
    status: "reachable",
    httpStatus: 407,
    latencyMs: 12,
    errorMessage: "Proxy reachable — HTTP 407 Proxy Authentication Required",
  });
});
test("proxy CONNECT authentication rejection remains reachable", () => {
  expect(
    classifyPoolConnectError(
      "pool-1",
      new Error("Proxy CONNECT failed: 407 Proxy Authentication Required"),
      15,
    ),
  ).toEqual({
    poolId: "pool-1",
    status: "reachable",
    httpStatus: 407,
    latencyMs: 15,
    errorMessage: "Proxy reachable — HTTP 407 Proxy Authentication Required",
  });
  expect(classifyPoolConnectError("pool-1", new Error("connection refused"), 15)).toBeUndefined();
});

test("other reachable HTTP errors do not become proxy failures", () => {
  expect(classifyPoolProbeResponse("pool-1", { ok: false, status: 503 }, 9)).toEqual({
    poolId: "pool-1",
    status: "healthy",
    latencyMs: 9,
    errorMessage: "HTTP 503 (reachable)",
  });
});

test("successful canary responses remain healthy without an error message", () => {
  expect(classifyPoolProbeResponse("pool-1", { ok: true, status: 204 }, 7)).toEqual({
    poolId: "pool-1",
    status: "healthy",
    latencyMs: 7,
  });
});
