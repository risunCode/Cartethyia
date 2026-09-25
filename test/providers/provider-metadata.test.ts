import { describe, expect, test } from "bun:test";
import {
  boundedUpstreamArray,
  boundedUpstreamNumber,
  providerDisplayName,
  sanitizeUpstreamLabel,
  validateUpstreamBaseUrl,
} from "../../src/providers/provider-metadata";

describe("providerDisplayName", () => {
  test("maps builtin ids to their human display names", () => {
    expect(providerDisplayName("cb")).toBe("CodeBuddy");
    expect(providerDisplayName("cbcn")).toBe("CodeBuddy CN");
    expect(providerDisplayName("antigravity")).toBe("Antigravity");
  });

  test("falls back to the provider id for unknown providers", () => {
    expect(providerDisplayName("unknown-provider")).toBe("unknown-provider");
  });
});

describe("sanitizeUpstreamLabel", () => {
  test("strips control characters including newlines, then trims", () => {
    expect(sanitizeUpstreamLabel("  ab\u0000c\nd\u007f  ")).toBe("abcd");
  });

  test("caps length at the requested bound", () => {
    expect(sanitizeUpstreamLabel("x".repeat(300), 10)).toBe("x".repeat(10));
  });

  test("returns undefined for non-strings and blank input", () => {
    expect(sanitizeUpstreamLabel(42)).toBeUndefined();
    expect(sanitizeUpstreamLabel("   ")).toBeUndefined();
    expect(sanitizeUpstreamLabel(undefined)).toBeUndefined();
  });
});

describe("boundedUpstreamNumber", () => {
  test("accepts finite numeric strings within bounds", () => {
    expect(boundedUpstreamNumber("128", { min: 1, max: 200 })).toBe(128);
  });

  test("rejects non-finite, non-numeric, and out-of-range values", () => {
    expect(boundedUpstreamNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(boundedUpstreamNumber(Number.NaN)).toBeUndefined();
    expect(boundedUpstreamNumber("abc")).toBeUndefined();
    expect(boundedUpstreamNumber(0, { min: 1 })).toBeUndefined();
    expect(boundedUpstreamNumber(1_000, { max: 100 })).toBeUndefined();
  });
});

describe("boundedUpstreamArray", () => {
  test("truncates arrays above the cap", () => {
    expect(boundedUpstreamArray([1, 2, 3], 2)).toEqual([1, 2]);
  });

  test("returns undefined for non-arrays", () => {
    expect(boundedUpstreamArray("nope")).toBeUndefined();
    expect(boundedUpstreamArray({ length: 1 })).toBeUndefined();
  });

  test("returns small arrays unchanged", () => {
    const input = [{ id: "a" }];
    expect(boundedUpstreamArray(input)).toBe(input);
  });
});

describe("validateUpstreamBaseUrl", () => {
  test("accepts https and strips trailing slashes", () => {
    expect(validateUpstreamBaseUrl("https://server.example.com/")).toBe(
      "https://server.example.com",
    );
  });

  test("rejects http unless explicitly allowed", () => {
    expect(validateUpstreamBaseUrl("http://server.example.com")).toBeUndefined();
    expect(validateUpstreamBaseUrl("http://server.example.com", { allowHttp: true })).toBe(
      "http://server.example.com",
    );
  });

  test("rejects embedded credentials and non-http protocols", () => {
    expect(validateUpstreamBaseUrl("https://user:pass@server.example.com")).toBeUndefined();
    expect(validateUpstreamBaseUrl("file:///etc/passwd")).toBeUndefined();
    expect(validateUpstreamBaseUrl("javascript:alert(1)")).toBeUndefined();
  });

  test("enforces an optional host allowlist", () => {
    expect(
      validateUpstreamBaseUrl("https://evil.example.com", {
        allowedHosts: ["server.codeium.com"],
      }),
    ).toBeUndefined();
    expect(
      validateUpstreamBaseUrl("https://server.codeium.com", {
        allowedHosts: ["server.codeium.com"],
      }),
    ).toBe("https://server.codeium.com");
  });
});
