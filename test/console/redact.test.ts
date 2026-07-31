import { describe, expect, test } from "bun:test";
import { redactHeaders, redactPayload, redactText, isSensitiveHeader } from "../../src/console/tracking/redact";

describe("redactPayload", () => {
  test("redacts the VALUE of a sensitive field, not just its key label", () => {
    const out = redactPayload({ api_key: "sk-live-super-secret-value" });
    expect(out).not.toContain("sk-live-super-secret-value");
    expect(out).toContain("[API_KEY_REDACTED]");
  });

  test("redacts every sensitive field independently in the same payload", () => {
    const out = redactPayload({ token: "tok-123", password: "hunter2", credential: "cred-xyz", bearer: "bear-abc", secret: "shh-secret" });
    for (const leaked of ["tok-123", "hunter2", "cred-xyz", "bear-abc", "shh-secret"]) {
      expect(out).not.toContain(leaked);
    }
  });

  test("leaves non-sensitive fields untouched", () => {
    const out = redactPayload({ model: "gpt-4o", api_key: "sk-secret" });
    expect(out).toContain('"model":"gpt-4o"');
  });

  test("handles nested objects containing sensitive fields", () => {
    const out = redactPayload({ auth: { token: "nested-secret-token" } });
    expect(out).not.toContain("nested-secret-token");
  });

  test("returns null for undefined/null input", () => {
    expect(redactPayload(undefined)).toBeNull();
    expect(redactPayload(null)).toBeNull();
  });
});

describe("redactHeaders / isSensitiveHeader", () => {
  test("drops authorization-family headers entirely", () => {
    expect(isSensitiveHeader("Authorization")).toBe(true);
    expect(isSensitiveHeader("Proxy-Authorization")).toBe(true);
    const out = redactHeaders({ authorization: "Bearer sk-abc", "x-custom": "keep-me" });
    expect(out.authorization).toBeUndefined();
    expect(out["x-custom"]).toBe("keep-me");
  });

  test("masks bearer/sk-/pt- prefixed header values that slip through under another name", () => {
    const out = redactHeaders({ "x-forwarded-token": "sk-abcdefghijklmnopqrstuvwx" });
    expect(out["x-forwarded-token"]).toBe("[REDACTED]");
  });
});

describe("redactText", () => {
  test("masks sk-/pt- style secrets embedded in free text", () => {
    const out = redactText('{"key":"sk-abcdefghijklmnopqrstuvwx"}');
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });
});
