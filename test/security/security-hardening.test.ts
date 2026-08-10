import { describe, expect, test } from "bun:test";
import { applySecurityHeaders } from "../../src/security/headers";
import { assertProductionBootstrapEnvironment } from "../../src/security/secrets";
import { createPayloadCapture } from "../../src/application/request/payload-capture";
import { hasConflictingCredentials, requestToken } from "../../src/middleware/proxy";

describe("security hardening contracts", () => {
  test("rejects ambiguous API credentials instead of silently choosing one", () => {
    const request = new Request("http://127.0.0.1:12800/v1/messages", {
      headers: { authorization: "Bearer bearer-value", "x-api-key": "ck-key-value" },
    });

    expect(hasConflictingCredentials(request)).toBe(true);
    expect(requestToken(request)).toBeNull();
  });


  test("rejects production placeholder bootstrap credentials", () => {
    expect(() => assertProductionBootstrapEnvironment({ NODE_ENV: "production", CONSOLE_PASSWORD: "change-me" })).toThrow();
    expect(() => assertProductionBootstrapEnvironment({ NODE_ENV: "production", CONSOLE_JWT_SECRET: "replace-with-a-long-random-secret" })).toThrow();
    expect(() => assertProductionBootstrapEnvironment({ NODE_ENV: "production", CONSOLE_PASSWORD: "a-strong-production-password", CONSOLE_JWT_SECRET: "a-strong-production-jwt-secret-with-32-chars" })).not.toThrow();
  });
  test("accepts short non-placeholder bootstrap credentials", () => {
    expect(() => assertProductionBootstrapEnvironment({ NODE_ENV: "production", CONSOLE_PASSWORD: "Deras#", BOOTSTRAP_PROXY_API_KEY: "risuncode-internal" })).not.toThrow();
    expect(() => assertProductionBootstrapEnvironment({ NODE_ENV: "production", CONSOLE_PASSWORD: "Deras#", BOOTSTRAP_PROXY_API_KEY: "" })).toThrow();
    expect(() => assertProductionBootstrapEnvironment({ NODE_ENV: "production", CONSOLE_PASSWORD: "Deras#", BOOTSTRAP_PROXY_API_KEY: "change-me" })).toThrow();
  });

  test("allows browser-local custom media while keeping console CSP restrictive", () => {
    const headers = new Headers();
    applySecurityHeaders(headers, { html: true });
    const policy = headers.get("content-security-policy");

    expect(policy).toContain("img-src 'self' data: blob: https:");
    expect(policy).toContain("media-src 'self' blob:");
    expect(policy).toContain("object-src 'none'");
  });
  test("redacts credentials from JSON and malformed payload captures", async () => {
    const saved: Array<{ text: string }> = [];
    const capture = createPayloadCapture("request-1", {
      save: (_requestId, _kind, artifact) => saved.push(artifact),
    });
    capture.request(JSON.stringify({ authorization: "Bearer secret-token", nested: { refresh_token: "rotated-secret" } }));
    capture.request("authorization: Bearer raw-secret; refresh_token=raw-refresh");
    await capture.settle();

    expect(saved).toHaveLength(2);
    for (const artifact of saved) {
      expect(artifact.text).not.toContain("secret-token");
      expect(artifact.text).not.toContain("rotated-secret");
      expect(artifact.text).not.toContain("raw-secret");
      expect(artifact.text).not.toContain("raw-refresh");
      expect(artifact.text).toContain("[REDACTED]");
    }
  });
});
