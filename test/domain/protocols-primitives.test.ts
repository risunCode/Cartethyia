import { describe, expect, test } from "bun:test";
import {
  abortedError,
  applicationError,
  boundJsonLength,
  isIpLiteral,
  isPrivateUseName,
  isRecord,
  isUnsafeIp,
  isProtocolError,
  MAX_IMAGE_COUNT,
  messageText,
  normalizeFail,
  normalizeHostname,
  normalizeOk,
  normalizeStream,
  nullableNumber,
  narrowArray,
  narrowBoolean,
  narrowNumber,
  narrowObject,
  narrowString,
  protocolError,
  pushImageReference,
  type ProtocolError,
} from "../../src/domain/protocols";
import type { ImageReference, NormalizedMessage, NormalizedProviderRequest } from "../../src/domain/contracts";

/**
 * Protocol boundary primitives in isolation: type narrowing, byte bounds,
 * SSRF-safe hostname/IP classification, image-reference accounting, and the
 * result/error constructors that every normalizer composes.
 *
 * No network, no DB, no fetch — these are the pure validators that the
 * surface dispatchers and protocol adapters build on.
 */

// ---------------------------------------------------------------------------
// isRecord
// ---------------------------------------------------------------------------

describe("isRecord", () => {
  test.each([
    ["plain object", {}, true],
    ["object with fields", { a: 1 }, true],
    ["Object.create(null)", Object.create(null), true],
  ])("returns true for %s", (_label, value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });

  test.each([
    ["array", [1, 2], false],
    ["null", null, false],
    ["string", "hello", false],
    ["number", 42, false],
    ["boolean", true, false],
    ["undefined", undefined, false],
  ])("returns false for %s", (_label, value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// nullableNumber
// ---------------------------------------------------------------------------

describe("nullableNumber", () => {
  test.each([
    ["positive integer", 5, 5],
    ["zero", 0, 0],
    ["negative", -3, -3],
    ["float", 1.5, 1.5],
  ])("returns the number for %s", (_label, value, expected) => {
    expect(nullableNumber(value)).toBe(expected);
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["string", "5"],
    ["boolean", true],
    ["null", null],
    ["undefined", undefined],
    ["object", {}],
  ])("returns null for %s", (_label, value) => {
    expect(nullableNumber(value)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// messageText
// ---------------------------------------------------------------------------

describe("messageText", () => {
  test("joins multiple text blocks with newline", () => {
    const message: NormalizedMessage = {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
    };
    expect(messageText(message)).toBe("hello\nworld");
  });

  test("returns the single text block", () => {
    const message: NormalizedMessage = {
      role: "assistant",
      content: [{ type: "text", text: "only" }],
    };
    expect(messageText(message)).toBe("only");
  });

  test("filters out non-text blocks", () => {
    const message: NormalizedMessage = {
      role: "user",
      content: [
        { type: "image", image: { kind: "url", value: "https://x/y.png", mediaType: null } },
        { type: "text", text: "keep me" },
        { type: "tool_use", toolName: "f" },
      ],
    };
    expect(messageText(message)).toBe("keep me");
  });

  test("returns empty string for empty content", () => {
    const message: NormalizedMessage = { role: "user", content: [] };
    expect(messageText(message)).toBe("");
  });

  test("returns empty string when no text blocks are present", () => {
    const message: NormalizedMessage = {
      role: "user",
      content: [{ type: "image", image: { kind: "url", value: "https://x/y.png", mediaType: null } }],
    };
    expect(messageText(message)).toBe("");
  });

  test("treats a text block with missing text as empty string", () => {
    const message: NormalizedMessage = {
      role: "user",
      content: [
        { type: "text" },
        { type: "text", text: "second" },
      ],
    };
    expect(messageText(message)).toBe("\nsecond");
  });
});

// ---------------------------------------------------------------------------
// normalizeStream
// ---------------------------------------------------------------------------

describe("normalizeStream", () => {
  test.each([
    ["undefined", undefined, false],
    ["null", null, false],
    ["true", true, true],
    ["false", false, false],
  ])("returns %s → %s", (_label, raw, expected) => {
    expect(normalizeStream(raw)).toBe(expected);
  });

  test.each([
    ["number", 1],
    ["string", "true"],
    ["object", {}],
    ["array", []],
  ])("returns a ProtocolError for %s", (_label, raw) => {
    const result = normalizeStream(raw);
    expect(isProtocolError(result)).toBe(true);
    if (isProtocolError(result)) {
      expect(result.field).toBe("stream");
      expect(result.sanitizedMessage).toContain("expected a boolean");
    }
  });
});

// ---------------------------------------------------------------------------
// narrowObject / narrowString / narrowBoolean / narrowNumber / narrowArray
// ---------------------------------------------------------------------------

describe("narrowObject", () => {
  test("returns the object for a plain object", () => {
    const obj = { a: 1 };
    expect(narrowObject(obj, "body")).toBe(obj);
  });

  test.each([
    ["array", [1, 2]],
    ["null", null],
    ["string", "x"],
    ["number", 1],
  ])("returns a ProtocolError for %s", (_label, value) => {
    const result = narrowObject(value, "body");
    expect(isProtocolError(result)).toBe(true);
    if (isProtocolError(result)) {
      expect(result.field).toBe("body");
      expect(result.sanitizedMessage).toContain("expected an object");
    }
  });
});

describe("narrowString", () => {
  test("returns the string when within length", () => {
    expect(narrowString("hello", "name", 10)).toBe("hello");
  });

  test("returns the string exactly at the length limit", () => {
    expect(narrowString("abcde", "name", 5)).toBe("abcde");
  });

  test.each([
    ["number", 5],
    ["boolean", true],
    ["null", null],
    ["object", {}],
  ])("returns a ProtocolError for non-string %s", (_label, value) => {
    const result = narrowString(value, "name", 10);
    expect(isProtocolError(result)).toBe(true);
    if (isProtocolError(result)) {
      expect(result.field).toBe("name");
      expect(result.sanitizedMessage).toContain("expected a string");
    }
  });

  test("returns a ProtocolError when the string exceeds the max length", () => {
    const result = narrowString("abcdefgh", "name", 5);
    expect(isProtocolError(result)).toBe(true);
    if (isProtocolError(result)) {
      expect(result.field).toBe("name");
      expect(result.sanitizedMessage).toContain("exceeds maximum length");
    }
  });
});

describe("narrowBoolean", () => {
  test.each([
    ["true", true, true],
    ["false", false, false],
  ])("returns the boolean for %s", (_label, value, expected) => {
    expect(narrowBoolean(value, "flag")).toBe(expected);
  });

  test.each([
    ["number", 1],
    ["string", "true"],
    ["null", null],
    ["object", {}],
  ])("returns a ProtocolError for %s", (_label, value) => {
    const result = narrowBoolean(value, "flag");
    expect(isProtocolError(result)).toBe(true);
    if (isProtocolError(result)) {
      expect(result.field).toBe("flag");
      expect(result.sanitizedMessage).toContain("expected a boolean");
    }
  });
});

describe("narrowNumber", () => {
  test.each([
    ["positive integer", 5, {}],
    ["zero", 0, {}],
    ["negative", -3, {}],
    ["float", 1.5, {}],
  ])("returns the number for %s", (_label, value, opts) => {
    expect(narrowNumber(value, "n", opts)).toBe(value);
  });

  test("rejects NaN and Infinity", () => {
    expect(isProtocolError(narrowNumber(Number.NaN, "n"))).toBe(true);
    expect(isProtocolError(narrowNumber(Number.POSITIVE_INFINITY, "n"))).toBe(true);
  });

  test("rejects non-numbers", () => {
    expect(isProtocolError(narrowNumber("5", "n"))).toBe(true);
    expect(isProtocolError(narrowNumber(true, "n"))).toBe(true);
    expect(isProtocolError(narrowNumber(null, "n"))).toBe(true);
  });

  test("rejects non-integer when integer option is set", () => {
    const result = narrowNumber(1.5, "n", { integer: true });
    expect(isProtocolError(result)).toBe(true);
    if (isProtocolError(result)) {
      expect(result.sanitizedMessage).toContain("expected an integer");
    }
  });

  test("accepts integer when integer option is set", () => {
    expect(narrowNumber(5, "n", { integer: true })).toBe(5);
  });

  test("rejects value below min", () => {
    const result = narrowNumber(2, "n", { min: 5 });
    expect(isProtocolError(result)).toBe(true);
    if (isProtocolError(result)) {
      expect(result.sanitizedMessage).toContain("must be at least");
    }
  });

  test("rejects value above max", () => {
    const result = narrowNumber(10, "n", { max: 5 });
    expect(isProtocolError(result)).toBe(true);
    if (isProtocolError(result)) {
      expect(result.sanitizedMessage).toContain("must be at most");
    }
  });

  test("accepts value at min and max boundaries", () => {
    expect(narrowNumber(5, "n", { min: 5, max: 5 })).toBe(5);
  });
});

describe("narrowArray", () => {
  test("returns the array when within length", () => {
    const arr = [1, 2, 3];
    expect(narrowArray(arr, "items", 5)).toBe(arr);
  });

  test("returns the array at the exact length limit", () => {
    const arr = [1, 2, 3, 4, 5];
    expect(narrowArray(arr, "items", 5)).toBe(arr);
  });

  test.each([
    ["object", {}],
    ["string", "abc"],
    ["number", 3],
    ["null", null],
  ])("returns a ProtocolError for %s", (_label, value) => {
    const result = narrowArray(value, "items", 5);
    expect(isProtocolError(result)).toBe(true);
    if (isProtocolError(result)) {
      expect(result.field).toBe("items");
      expect(result.sanitizedMessage).toContain("expected an array");
    }
  });

  test("returns a ProtocolError when the array exceeds the max length", () => {
    const result = narrowArray([1, 2, 3, 4, 5, 6], "items", 3);
    expect(isProtocolError(result)).toBe(true);
    if (isProtocolError(result)) {
      expect(result.sanitizedMessage).toContain("exceeds maximum length");
    }
  });
});

// ---------------------------------------------------------------------------
// boundJsonLength
// ---------------------------------------------------------------------------

describe("boundJsonLength", () => {
  test("returns null for a value within the serialized limit", () => {
    expect(boundJsonLength({ a: 1 }, "schema", 10)).toBe(null);
  });

  test("returns null for null (serializes to 'null', 4 chars)", () => {
    expect(boundJsonLength(null, "schema", 10)).toBe(null);
  });

  test("returns null for undefined (JSON.stringify returns undefined)", () => {
    expect(boundJsonLength(undefined, "schema", 10)).toBe(null);
  });

  test("returns a ProtocolError when the serialized form exceeds the limit", () => {
    const result = boundJsonLength({ a: "long string here" }, "schema", 5);
    expect(isProtocolError(result)).toBe(true);
    if (isProtocolError(result)) {
      expect(result.field).toBe("schema");
      expect(result.sanitizedMessage).toContain("exceeds");
    }
  });

  test("accepts a value exactly at the serialized length", () => {
    // JSON.stringify({a:1}) === '{"a":1}' (7 chars)
    expect(boundJsonLength({ a: 1 }, "schema", 7)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// normalizeHostname
// ---------------------------------------------------------------------------

describe("normalizeHostname", () => {
  test("lowercases the host", () => {
    expect(normalizeHostname("Example.COM")).toBe("example.com");
  });

  test("strips a single trailing dot", () => {
    expect(normalizeHostname("example.com.")).toBe("example.com");
  });

  test("strips brackets from bracketed IPv6 literals", () => {
    expect(normalizeHostname("[::1]")).toBe("::1");
  });

  test("strips the zone id (percent scope)", () => {
    expect(normalizeHostname("fe80::1%eth0")).toBe("fe80::1");
  });

  test("returns null for an empty string", () => {
    expect(normalizeHostname("")).toBe(null);
  });

  test("returns null for a string that is only brackets", () => {
    expect(normalizeHostname("[]")).toBe(null);
  });

  test("preserves a normal fully-qualified domain", () => {
    expect(normalizeHostname("api.openai.com")).toBe("api.openai.com");
  });
});

// ---------------------------------------------------------------------------
// isPrivateUseName
// ---------------------------------------------------------------------------

describe("isPrivateUseName", () => {
  test.each([
    ["localhost", "localhost"],
    ["foo.localhost", "foo.localhost"],
    ["myhost.local", "myhost.local"],
    ["service.internal", "service.internal"],
    ["dev.lan", "dev.lan"],
    ["my.localdomain", "my.localdomain"],
    ["router.home.arpa", "router.home.arpa"],
  ])("returns true for %s", (_label, host) => {
    expect(isPrivateUseName(host)).toBe(true);
  });

  test.each([
    ["example.com", "example.com"],
    ["api.openai.com", "api.openai.com"],
    ["sub.domain.org", "sub.domain.org"],
    ["myhost.com", "myhost.com"],
  ])("returns false for %s", (_label, host) => {
    expect(isPrivateUseName(host)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isIpLiteral
// ---------------------------------------------------------------------------

describe("isIpLiteral", () => {
  test.each([
    ["IPv4 loopback", "127.0.0.1"],
    ["IPv4 public", "8.8.8.8"],
    ["IPv4 private", "10.0.0.1"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 full", "2001:0db8:0000:0000:0000:0000:0000:0001"],
  ])("returns true for %s (%s)", (_label, host) => {
    expect(isIpLiteral(host)).toBe(true);
  });

  test.each([
    ["plain domain", "example.com"],
    ["subdomain", "api.openai.com"],
    ["single label", "localhost"],
    ["bracketed IPv6", "[::1]"],
    ["malformed IPv4", "999.999.999.999"],
    ["malformed IPv6", "::g"],
  ])("returns false for %s", (_label, host) => {
    expect(isIpLiteral(host)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isUnsafeIp
// ---------------------------------------------------------------------------

describe("isUnsafeIp — IPv4 private/reserved ranges", () => {
  test.each([
    ["0.0.0.0/8 (current network)", "0.0.0.0"],
    ["0.0.0.0/8 upper", "0.255.255.255"],
    ["10.0.0.0/8 (private)", "10.0.0.1"],
    ["10.255.255.255", "10.255.255.255"],
    ["100.64.0.0/10 (CGNAT)", "100.64.0.1"],
    ["100.127.255.255", "100.127.255.255"],
    ["127.0.0.0/8 (loopback)", "127.0.0.1"],
    ["127.255.255.255", "127.255.255.255"],
    ["169.254.0.0/16 (link-local)", "169.254.1.1"],
    ["172.16.0.0/12 (private)", "172.16.0.1"],
    ["172.31.255.255", "172.31.255.255"],
    ["192.0.0.0/24", "192.0.0.1"],
    ["192.0.2.0/24 (TEST-NET-1)", "192.0.2.1"],
    ["192.168.0.0/16 (private)", "192.168.1.1"],
    ["198.18.0.0/15 (benchmarking)", "198.18.0.1"],
    ["198.51.100.0/24 (TEST-NET-2)", "198.51.100.1"],
    ["203.0.113.0/24 (TEST-NET-3)", "203.0.113.1"],
    ["224.0.0.0/4 (multicast)", "224.0.0.1"],
    ["240.0.0.0/4 (reserved)", "240.0.0.1"],
    ["255.255.255.255 (broadcast)", "255.255.255.255"],
  ])("returns true for %s (%s)", (_label, ip) => {
    expect(isUnsafeIp(ip)).toBe(true);
  });

  test.each([
    ["8.8.8.8", "8.8.8.8"],
    ["1.1.1.1", "1.1.1.1"],
    ["93.184.216.34", "93.184.216.34"],
    ["172.32.0.1 (just outside /12)", "172.32.0.1"],
    ["192.0.1.1 (outside 192.0.0/24)", "192.0.1.1"],
  ])("returns false for public %s", (_label, ip) => {
    expect(isUnsafeIp(ip)).toBe(false);
  });
});

describe("isUnsafeIp — IPv6 private/reserved ranges", () => {
  test.each([
    ["unspecified ::", "::"],
    ["loopback ::1", "::1"],
    ["IPv4-compatible ::/96", "::0.0.0.1"],
    ["IPv4-mapped ::ffff:0:0/96 (private IPv4)", "::ffff:10.0.0.1"],
    ["IPv4-mapped ::ffff:0:0/96 (public IPv4 still blocked)", "::ffff:8.8.8.8"],
    ["NAT64 64:ff9b::/96 (private IPv4)", "64:ff9b::10.0.0.1"],
    ["unique-local fc00::/7", "fc00::1"],
    ["unique-local fd00::/7", "fd00::1"],
    ["link-local fe80::/10", "fe80::1"],
    ["multicast ff00::/8", "ff02::1"],
    ["documentation 2001:db8::/32", "2001:db8::1"],
    ["ORCHID 2001:10::/28", "2001:10::1"],
    ["benchmarking 2001:2::/48", "2001:2::1"],
    ["discard-only 100::/64", "100::"],
  ])("returns true for %s (%s)", (_label, ip) => {
    expect(isUnsafeIp(ip)).toBe(true);
  });

  test.each([
    ["Cloudflare 2606:4700:4700::1111", "2606:4700:4700::1111"],
    ["Google 2001:4860:4860::8888", "2001:4860:4860::8888"],
  ])("returns false for public %s", (_label, ip) => {
    expect(isUnsafeIp(ip)).toBe(false);
  });

  test("returns true for a malformed IP (not parseable as IPv6)", () => {
    // isUnsafeIp returns true when ipv6ToBigInt yields null for a non-IPv4 host.
    expect(isUnsafeIp("not-an-ip::garbage")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pushImageReference
// ---------------------------------------------------------------------------

describe("pushImageReference", () => {
  const urlRef: ImageReference = { kind: "url", value: "https://example.com/img.png", mediaType: null };
  const dataRef: ImageReference = { kind: "data", value: "data:image/png;base64,iVBOR=", mediaType: "image/png" };

  test("appends a reference to an empty target", () => {
    const target: ImageReference[] = [];
    const result = pushImageReference(target, urlRef, "images[0]");
    expect(result).toBe(null);
    expect(target).toEqual([urlRef]);
  });

  test("appends a second reference", () => {
    const target: ImageReference[] = [urlRef];
    const result = pushImageReference(target, dataRef, "images[1]");
    expect(result).toBe(null);
    expect(target).toEqual([urlRef, dataRef]);
  });

  test(`rejects once the array reaches MAX_IMAGE_COUNT (${MAX_IMAGE_COUNT})`, () => {
    const target: ImageReference[] = [];
    for (let i = 0; i < MAX_IMAGE_COUNT; i += 1) target.push(urlRef);
    expect(target.length).toBe(MAX_IMAGE_COUNT);
    const result = pushImageReference(target, dataRef, "images[64]");
    expect(isProtocolError(result)).toBe(true);
    if (isProtocolError(result)) {
      expect(result.field).toBe("images[64]");
      expect(result.sanitizedMessage).toContain("exceeds maximum");
    }
    expect(target.length).toBe(MAX_IMAGE_COUNT);
  });

  test("accepts a reference when the count is one below the cap", () => {
    const target: ImageReference[] = [];
    for (let i = 0; i < MAX_IMAGE_COUNT - 1; i += 1) target.push(urlRef);
    const result = pushImageReference(target, dataRef, "images[last]");
    expect(result).toBe(null);
    expect(target.length).toBe(MAX_IMAGE_COUNT);
  });
});

// ---------------------------------------------------------------------------
// normalizeOk / normalizeFail
// ---------------------------------------------------------------------------

describe("normalizeOk / normalizeFail", () => {
  test("normalizeOk wraps a request with ok: true", () => {
    const request = {
      model: "gpt-4o",
      messages: [],
      tools: [],
      stream: false,
      responseFormat: "text",
      reasoning: "default",
      maxOutputTokens: null,
      images: [],
      sourceSurface: "openai-chat",
      signal: new AbortController().signal,
    } as unknown as NormalizedProviderRequest;
    const result = normalizeOk(request);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request).toBe(request);
  });

  test("normalizeFail wraps an error with ok: false", () => {
    const error = protocolError("field", "bad value");
    const result = normalizeFail(error);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(error);
  });

  test("normalizeOk and normalizeFail are mutually exclusive by the ok tag", () => {
    const okResult = normalizeOk({} as NormalizedProviderRequest);
    const failResult = normalizeFail(protocolError("f", "m"));
    expect(okResult.ok).toBe(true);
    expect(failResult.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// abortedError
// ---------------------------------------------------------------------------

describe("abortedError", () => {
  test("returns null when the signal is not aborted", () => {
    const controller = new AbortController();
    expect(abortedError(controller.signal)).toBe(null);
  });

  test("returns a client_aborted error (status 499) when the signal is aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const result = abortedError(controller.signal);
    expect(result).not.toBe(null);
    if (result !== null) {
      expect(result.kind).toBe("client_aborted");
      expect(result.statusCode).toBe(499);
      expect(result.field).toBe("request");
      expect(result.retryable).toBe(false);
      expect(result.sanitizedMessage).toContain("aborted");
    }
  });
});

// ---------------------------------------------------------------------------
// protocolError / applicationError
// ---------------------------------------------------------------------------

describe("protocolError", () => {
  test("constructs an invalid_request error with status 400", () => {
    const error = protocolError("messages[0].content", "expected a string");
    expect(error.kind).toBe("invalid_request");
    expect(error.statusCode).toBe(400);
    expect(error.field).toBe("messages[0].content");
    expect(error.retryable).toBe(false);
    expect(error.routeScope).toBe(null);
    expect(error.retryAt).toBe(null);
    expect(typeof error.sanitizedMessage).toBe("string");
    expect(error.sanitizedMessage.length).toBeGreaterThan(0);
  });

  test("sanitizes the message (truncates to the max error message length)", () => {
    const longMessage = "x".repeat(500);
    const error = protocolError("field", longMessage);
    expect(error.sanitizedMessage.length).toBeLessThanOrEqual(240);
  });

  test("is identified by isProtocolError", () => {
    const error = protocolError("f", "m");
    expect(isProtocolError(error)).toBe(true);
  });
});

describe("applicationError", () => {
  test("constructs an error with the given kind, status, field, and message", () => {
    const error = applicationError("authentication_failed", 401, "key", "invalid api key");
    expect(error.kind).toBe("authentication_failed");
    expect(error.statusCode).toBe(401);
    expect(error.field).toBe("key");
    expect(error.retryable).toBe(false);
    expect(error.routeScope).toBe(null);
    expect(error.retryAt).toBe(null);
    expect(typeof error.sanitizedMessage).toBe("string");
    expect(error.sanitizedMessage.length).toBeGreaterThan(0);
  });

  test("is identified by isProtocolError", () => {
    const error = applicationError("provider_rate_limited", 429, "provider", "rate limited");
    expect(isProtocolError(error)).toBe(true);
  });
});

describe("isProtocolError", () => {
  test.each([
    ["ProtocolError", protocolError("f", "m")],
    ["applicationError", applicationError("internal_error", 500, "x", "y")],
  ])("returns true for %s", (_label, value: ProtocolError) => {
    expect(isProtocolError(value)).toBe(true);
  });

  test.each([
    ["plain object without field", { a: 1 }],
    ["null", null],
    ["string", "hello"],
    ["number", 42],
    ["array", [1, 2]],
    ["object missing retryable", { field: "f", sanitizedMessage: "m" }],
    ["object with retryable true", { field: "f", retryable: true, sanitizedMessage: "m" }],
  ])("returns false for %s", (_label, value) => {
    expect(isProtocolError(value)).toBe(false);
  });
});
