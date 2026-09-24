import { describe, expect, test } from "bun:test";
import { parseAgentConfig, ProxyConfigError } from "../../src/network/types";
import { DEFAULT_BOUNDS } from "../../src/transport/resources";

describe("parseAgentConfig", () => {
  test("accepts an empty or non-record value as defaults", () => {
    expect(parseAgentConfig(undefined)).toEqual({});
    expect(parseAgentConfig(null)).toEqual({});
    expect(parseAgentConfig("nope")).toEqual({});
    expect(parseAgentConfig({})).toEqual({});
  });

  test("parses valid tuning knobs", () => {
    expect(
      parseAgentConfig({ maxSockets: 50, maxFreeSockets: 10, keepAliveTimeout: 30_000 }),
    ).toEqual({ maxSockets: 50, maxFreeSockets: 10, keepAliveTimeout: 30_000 });
  });

  test("accepts numeric strings for tuning knobs", () => {
    expect(parseAgentConfig({ maxSockets: "25" })).toEqual({ maxSockets: 25 });
  });

  test("rejects out-of-range and non-integer knobs", () => {
    expect(() => parseAgentConfig({ maxSockets: 0 })).toThrow(ProxyConfigError);
    expect(() => parseAgentConfig({ maxSockets: 100_001 })).toThrow(ProxyConfigError);
    expect(() => parseAgentConfig({ maxSockets: 1.5 })).toThrow(ProxyConfigError);
    expect(() => parseAgentConfig({ maxFreeSockets: -1 })).toThrow(ProxyConfigError);
    expect(() => parseAgentConfig({ keepAliveTimeout: "fast" })).toThrow(ProxyConfigError);
  });

  test("omits undefined knobs from the result", () => {
    expect(parseAgentConfig({ maxSockets: 10 })).toEqual({ maxSockets: 10 });
  });
});

describe("DEFAULT_BOUNDS", () => {
  test("carries the live production bounds", () => {
    expect(DEFAULT_BOUNDS.maxPostgresPoolSize).toBeGreaterThan(0);
    expect(DEFAULT_BOUNDS.maxTelemetryQueueBytes).toBeGreaterThan(0);
  });
});
