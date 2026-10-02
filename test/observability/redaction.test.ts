/**
 * Telemetry redaction and IP masking — the privacy boundary.
 *
 * Two audiences read telemetry, and this module serves both without letting one
 * contaminate the other:
 *
 * - **Redaction** is applied to anything leaving the process for storage or a
 *   log line. A credential that reaches a telemetry row is a credential written
 *   to disk in plaintext, so the rule is fail-closed: a key whose name *looks*
 *   secret is redacted even when the value is innocuous.
 * - **Reasoning is the deliberate exception.** `reasoning`, `thinking`,
 *   `encrypted_content`, and `signature` are passed through verbatim. Redacting
 *   them destroys the context a thinking model needs on multi-turn replay, and
 *   the earlier policy that did so was reported as broken conversations. This
 *   suite pins that exception so a future "hardening" pass cannot quietly
 *   reintroduce it.
 *
 * `maskClientIp` is the read-path mask: storage keeps the raw address so an
 * operator can still investigate, and the presentation layer drops the last
 * octet so a support screenshot does not publish a customer's IP.
 */
import { describe, expect, test } from "bun:test";
import {
  isOpaqueEncrypted,
  isSecretKeyName,
  maskClientIp,
  redactTelemetryValue,
} from "../../src/observability/redaction";

describe("isSecretKeyName", () => {
  test("matches every documented secret shape", () => {
    for (const key of [
      "authorization",
      "x-api-key",
      "api_key",
      "apikey",
      "credential",
      "credentials",
      "secret",
      "client_secret",
      "password",
      "passwords",
      "token",
      "access_token",
      "refresh_token",
      "id_token",
      "auth_token",
      "api_token",
      "bearer_token",
      "oauth_token",
      "session_token",
      "csrf_token",
      "device_token",
      "secret_token",
    ]) {
      expect({ key, secret: isSecretKeyName(key) }).toEqual({ key, secret: true });
    }
  });

  test("a *_token name is secret, but *_tokens is not", () => {
    // `*_tokens` is a usage *counter* (`cached_input_tokens`), not a credential.
    // Redacting it would erase the number an operator opened the page to read.
    expect(isSecretKeyName("input_token")).toBe(true);
    expect(isSecretKeyName("input_tokens")).toBe(false);
    expect(isSecretKeyName("output_tokens")).toBe(false);
    expect(isSecretKeyName("cached_input_tokens")).toBe(false);
    expect(isSecretKeyName("reasoning_tokens")).toBe(false);
  });

  test("a substring match catches compound names", () => {
    expect(isSecretKeyName("openai_api_key")).toBe(true);
    expect(isSecretKeyName("my_secret_value")).toBe(true);
    expect(isSecretKeyName("upstream_credentials")).toBe(true);
  });

  test("an innocuous name is not secret", () => {
    for (const key of ["model", "provider_id", "status", "latency_ms", "user_agent"]) {
      expect({ key, secret: isSecretKeyName(key) }).toEqual({ key, secret: false });
    }
  });
});

describe("isOpaqueEncrypted", () => {
  test("never reports a value as opaque-encrypted", () => {
    // The function exists as a named seam but returns `false` for everything:
    // reasoning and encrypted reasoning content must reach the consumer intact.
    // Pinned so a future change is a deliberate decision with a failing test.
    expect(isOpaqueEncrypted("encrypted_content", "abc")).toBe(false);
    expect(isOpaqueEncrypted("signature", "abc")).toBe(false);
    expect(isOpaqueEncrypted("anything", { nested: true })).toBe(false);
  });
});

describe("redactTelemetryValue — strings", () => {
  test("redacts an OpenAI-style key", () => {
    expect(redactTelemetryValue("sk-abcdefghijklmnop")).toBe("***REDACTED***[credential]");
  });

  test("redacts a bare Bearer token", () => {
    expect(redactTelemetryValue("Bearer abcdefghijklmnopqrst")).toBe(
      "***REDACTED***[credential]",
    );
  });

  test("a reply key long enough for the embedded sweep is fully redacted", () => {
    // The embedded-token sweep runs first and its `rk_` alternative requires 8+
    // characters, so a realistic reply key never reaches the prefix-preserving
    // branch below. The sweep is the stronger guarantee, and this is the shape a
    // real key has.
    expect(redactTelemetryValue("rk_abcdefghijklmnop")).toBe("***REDACTED***[credential]");
  });

  test("a short reply key keeps its prefix hint instead", () => {
    // The prefix branch is reachable only below the sweep's 8-character floor,
    // and it is what preserves the public identifier an operator uses to find
    // the key in the console while dropping the secret tail.
    expect(redactTelemetryValue("rk_abcd")).toBe("rk_ab***");
  });

  test("redacts a credential embedded mid-string", () => {
    // The anchored patterns below miss this shape, which is exactly how a
    // credential survived in a serialized error message.
    expect(
      redactTelemetryValue('{"message":"Invalid auth: Bearer eyJhbGciOiJIUzI1NiJ9"}'),
    ).toBe("***REDACTED***[credential]");
  });

  test("redacts an embedded sk- token in prose", () => {
    expect(redactTelemetryValue("upstream said sk-abcdefghijkl rejected")).toBe(
      "***REDACTED***[credential]",
    );
  });

  test("masks an IPv4 literal", () => {
    // An IP carries no analytic value in a telemetry read, and keeping it is a
    // privacy cost with no benefit.
    expect(redactTelemetryValue("203.0.113.7")).toBe("***REDACTED***[ip]");
  });

  test("masks an IPv4 with a port suffix", () => {
    expect(redactTelemetryValue("203.0.113.7:8080")).toBe("***REDACTED***[ip]");
  });

  test("leaves ordinary text untouched", () => {
    expect(redactTelemetryValue("the model returned an empty body")).toBe(
      "the model returned an empty body",
    );
  });

  test("leaves an IPv6 literal alone", () => {
    // Only the IPv4 shape is swept; a colon-bearing string is left for
    // `maskClientIp` on the presentation path.
    expect(redactTelemetryValue("2001:db8::1")).toBe("2001:db8::1");
  });

  test("passes null and undefined through", () => {
    expect(redactTelemetryValue(null)).toBeNull();
    expect(redactTelemetryValue(undefined)).toBeUndefined();
  });

  test("passes non-string primitives through", () => {
    expect(redactTelemetryValue(42)).toBe(42);
    expect(redactTelemetryValue(true)).toBe(true);
  });
});

describe("redactTelemetryValue — objects", () => {
  test("redacts a value under a secret key name", () => {
    expect(redactTelemetryValue({ api_key: "anything at all" })).toEqual({
      api_key: "***REDACTED***[secret-key]",
    });
  });

  test("redacts by key name even when the value looks innocuous", () => {
    // Fail closed on the name: a value's shape is not evidence that it is not a
    // secret, and a mis-named field is the operator's problem to fix, not a
    // reason to write the value to disk.
    expect(redactTelemetryValue({ password: "hunter2" })).toEqual({
      password: "***REDACTED***[secret-key]",
    });
  });

  test("does not redact usage counters", () => {
    // The carve-out that keeps the token numbers readable.
    expect(
      redactTelemetryValue({ input_tokens: 100, output_tokens: 20, cached_input_tokens: 5 }),
    ).toEqual({ input_tokens: 100, output_tokens: 20, cached_input_tokens: 5 });
  });

  test("key matching is case-insensitive", () => {
    expect(redactTelemetryValue({ API_KEY: "x" })).toEqual({
      API_KEY: "***REDACTED***[secret-key]",
    });
    expect(redactTelemetryValue({ Authorization: "x" })).toEqual({
      Authorization: "***REDACTED***[secret-key]",
    });
  });

  test("recurses into nested objects", () => {
    expect(
      redactTelemetryValue({ outer: { inner: { api_key: "x" } } }),
    ).toEqual({ outer: { inner: { api_key: "***REDACTED***[secret-key]" } } });
  });

  test("recurses into arrays", () => {
    expect(redactTelemetryValue({ items: [{ api_key: "x" }, { model: "gpt-4" }] })).toEqual({
      items: [{ api_key: "***REDACTED***[secret-key]" }, { model: "gpt-4" }],
    });
  });

  test("an array of credential-shaped strings is redacted element-wise", () => {
    expect(redactTelemetryValue(["sk-abcdefghijkl", "safe text"])).toEqual([
      "***REDACTED***[credential]",
      "safe text",
    ]);
  });

  test("preserves unrelated keys alongside a redacted one", () => {
    expect(redactTelemetryValue({ model: "gpt-4", token: "x", status: "ok" })).toEqual({
      model: "gpt-4",
      token: "***REDACTED***[secret-key]",
      status: "ok",
    });
  });
});

describe("redactTelemetryValue — the reasoning exception", () => {
  // The single most important behavior in this module: a thinking model's
  // context must survive telemetry capture. Redacting these was reported as
  // broken multi-turn conversations, because the model lost the reasoning it
  // had produced on the previous turn.
  const PASSTHROUGH_KEYS = [
    "reasoning_content",
    "reasoning",
    "thinking",
    "encrypted_content",
    "signature",
    "redacted_thinking",
  ] as const;

  for (const key of PASSTHROUGH_KEYS) {
    test(`passes "${key}" through verbatim`, () => {
      const payload = { [key]: "the model thought about 203.0.113.7 and sk-abcdefghijkl" };
      expect(redactTelemetryValue(payload)).toEqual(payload);
    });
  }

  test("passes an object-valued reasoning field through verbatim", () => {
    // A nested reasoning block must not be walked: its inner keys can be named
    // anything, and any rewrite changes the signature's validity.
    const reasoning = { content: "text", api_key: "not-actually-a-secret-here" };
    expect(redactTelemetryValue({ reasoning })).toEqual({ reasoning });
  });

  test("a reasoning field is passed through even when its value looks like a key", () => {
    const payload = { encrypted_content: "sk-abcdefghijklmnop" };
    expect(redactTelemetryValue(payload)).toEqual(payload);
  });

  test("other fields in the same object are still redacted", () => {
    // The exception is per field, not per object.
    const result = redactTelemetryValue({
      reasoning: "keep me",
      api_key: "hide me",
    }) as Record<string, unknown>;
    expect(result.reasoning).toBe("keep me");
    expect(result.api_key).toBe("***REDACTED***[secret-key]");
  });
});

describe("maskClientIp", () => {
  test("keeps the first three IPv4 octets", () => {
    expect(maskClientIp("203.0.113.7")).toBe("203.0.113.xxx");
  });

  test("masks the embedded IPv4 tail of a mapped IPv6 address", () => {
    // The common localhost/proxied shape; masking the whole thing would lose
    // the fact that it is a mapped address.
    expect(maskClientIp("::ffff:203.0.113.7")).toBe("::ffff:203.0.113.xxx");
  });

  test("keeps the first four IPv6 hextets", () => {
    expect(maskClientIp("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3:8d3:xxxx");
  });

  test("fully masks an IPv6 address too short to keep four hextets", () => {
    expect(maskClientIp("::1")).toBe("xxxx");
  });

  test("returns null for null or undefined", () => {
    // Distinguishing "no address" from "an address" matters: a null means the
    // gateway never resolved one, which is a different report than a masked one.
    expect(maskClientIp(null)).toBeNull();
    expect(maskClientIp(undefined)).toBeNull();
  });

  test("returns an empty string for an empty address", () => {
    expect(maskClientIp("")).toBe("");
    expect(maskClientIp("   ")).toBe("");
  });

  test("fully masks input it cannot parse", () => {
    // Fail closed: an unrecognised shape is not partially published.
    expect(maskClientIp("not-an-ip")).toBe("***");
    expect(maskClientIp("1.2.3")).toBe("***");
    expect(maskClientIp("1.2.3.4.5")).toBe("***");
  });

  test("tolerates surrounding whitespace", () => {
    expect(maskClientIp("  203.0.113.7  ")).toBe("203.0.113.xxx");
  });

  test("the masked form ends in the placeholder, never the original final octet", () => {
    // Stated as a shape rather than a substring test: `10.0.0.1` masked to
    // `10.0.0.xxx` legitimately still *contains* the character "1" in an earlier
    // octet, so a naive `not.toContain(lastOctet)` is not the property. The
    // property is that the final label is the placeholder.
    for (const address of ["203.0.113.7", "10.0.0.1", "255.255.255.255"]) {
      const masked = maskClientIp(address);
      expect(masked.endsWith(".xxx")).toBe(true);
      expect(masked).toBe(`${address.split(".").slice(0, 3).join(".")}.xxx`);
    }
  });
});
