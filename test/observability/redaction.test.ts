import { describe, expect, test } from "bun:test";
import { maskClientIp } from "../../src/observability/redaction";

describe("maskClientIp", () => {
  test("masks the last IPv4 octet", () => {
    expect(maskClientIp("203.0.113.7")).toBe("203.0.113.xxx");
  });

  test("masks the embedded IPv4 tail of a mapped address", () => {
    expect(maskClientIp("::ffff:203.0.113.7")).toBe("::ffff:203.0.113.xxx");
  });

  test("keeps the first four IPv6 hextets", () => {
    expect(maskClientIp("2001:db8:abcd:12::99")).toBe("2001:db8:abcd:12:xxxx");
  });

  test("fully masks short or unparseable input", () => {
    expect(maskClientIp("::1")).toBe("xxxx");
    expect(maskClientIp("not-an-ip")).toBe("***");
    expect(maskClientIp("1.2.3.9999")).toBe("***");
  });

  test("passes null through and keeps empty input empty", () => {
    expect(maskClientIp(null)).toBeNull();
    expect(maskClientIp(undefined)).toBeNull();
    expect(maskClientIp("")).toBe("");
    expect(maskClientIp("   ")).toBe("");
  });

  test("trims surrounding whitespace before masking", () => {
    expect(maskClientIp("  10.0.0.5  ")).toBe("10.0.0.xxx");
  });
});

import { isOpaqueEncrypted, isSecretKeyName, redactTelemetryValue } from "../../src/observability/redaction";

describe("isSecretKeyName", () => {
  test("flags credential-shaped key names", () => {
    expect(isSecretKeyName("credential")).toBe(true);
    expect(isSecretKeyName("api_key")).toBe(true);
    expect(isSecretKeyName("authorization")).toBe(true);
    expect(isSecretKeyName("x-api-key")).toBe(true);
    expect(isSecretKeyName("client_secret")).toBe(true);
    expect(isSecretKeyName("db_password")).toBe(true);
    expect(isSecretKeyName("refresh_token")).toBe(true);
  });

  test("leaves ordinary keys alone", () => {
    expect(isSecretKeyName("model")).toBe(false);
    expect(isSecretKeyName("provider_id")).toBe(false);
    expect(isSecretKeyName("access_tokens")).toBe(false);
  });
});

describe("isOpaqueEncrypted", () => {
  test("flags encrypted and long-reasoning values", () => {
    expect(isOpaqueEncrypted("encrypted_content", "x")).toBe(true);
    expect(isOpaqueEncrypted("some_encrypted_blob", "x")).toBe(true);
    expect(isOpaqueEncrypted("reasoning", "x".repeat(101))).toBe(true);
    expect(isOpaqueEncrypted("reasoning", "short")).toBe(true);
    expect(isOpaqueEncrypted("model", "x")).toBe(false);
  });
});

describe("redactTelemetryValue", () => {
  test("redacts credential-shaped strings and embedded tokens", () => {
    expect(redactTelemetryValue("sk-abcdef123456")).toBe("***REDACTED***[credential]");
    expect(redactTelemetryValue("Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig")).toBe(
      "***REDACTED***[credential]",
    );
    expect(redactTelemetryValue('upstream said {"message":"Invalid auth: Bearer abcdefghijklmnop"}')).toBe(
      "***REDACTED***[credential]",
    );
  });

  test("keeps a short reply-key hint, redacts long embedded tokens, masks IPv4", () => {
    // The embedded-token sweep fires first: an 8+ char rk_ token reads as a
    // credential, while a short rk_ value keeps its 5-char hint.
    expect(redactTelemetryValue("rk_ab")).toBe("rk_ab***");
    expect(redactTelemetryValue("rk_abc123secret")).toBe("***REDACTED***[credential]");
    expect(redactTelemetryValue("203.0.113.7")).toBe("***REDACTED***[ip]");
  });

  test("redacts secret keys and encrypted payloads inside objects", () => {
    expect(redactTelemetryValue({ api_key: "x", model: "m" })).toEqual({
      api_key: "***REDACTED***[secret-key]",
      model: "m",
    });
    expect(redactTelemetryValue({ encrypted_content: "blob" })).toEqual({
      encrypted_content: "***REDACTED***[encrypted]",
    });
  });

  test("recurses into arrays and passes safe values through", () => {
    expect(redactTelemetryValue(["a", "sk-abcdef123456"])).toEqual([
      "a",
      "***REDACTED***[credential]",
    ]);
    expect(redactTelemetryValue(null)).toBeNull();
    expect(redactTelemetryValue(42)).toBe(42);
    expect(redactTelemetryValue("plain text")).toBe("plain text");
  });
});
