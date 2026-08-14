import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, sanitizeErrorMessage } from "../../src/lib/api";
import {
  daemonApi,
  daemonFailure,
  daemonGet,
  normalizeDashboardSummary,
  redactOperatorValue,
  unwrapDaemonEnvelope,
} from "../../src/lib/daemon-api";
import { daemonDegradedFixture, daemonErrorFixture, daemonRedactedFixture, daemonSuccessFixture } from "../fixtures/daemon-api";

describe("daemon API contracts", () => {
  afterEach(() => vi.restoreAllMocks());

  test("unwraps a successful envelope and retains only typed dashboard health", () => {
    const result = normalizeDashboardSummary(unwrapDaemonEnvelope(daemonSuccessFixture));
    expect(result).toMatchObject({ accountCount: 2, health: { status: "ready", dependencies: { cache: "degraded" } } });
  });

  test("preserves stable daemon error codes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(daemonErrorFixture), { status: 403 })));
    await expect(daemonGet("/dashboard")).rejects.toEqual(new ApiError(403, "forbidden", "operator scope required"));
  });

  test("removes credential-shaped fields before values enter dashboard state", () => {
    const redacted = redactOperatorValue(daemonRedactedFixture);
    expect(redacted).toEqual({ data: { items: [{ id: "acct-1", providerId: "openai", label: "Primary", enabled: true, credentialHint: "sk-…1234", health: "healthy" }] } });
    expect(JSON.stringify(redacted)).not.toContain("must-not-enter-dashboard");
  });

  test("bounds recursive redaction and preserves only an opaque credential reference", () => {
    const redacted = redactOperatorValue({
      credentialRef: "provider:opaque-ref",
      nested: {
        prompt: "must-not-enter-dashboard",
        providerResponse: { token: "must-not-enter-dashboard" },
        response: "must-not-enter-dashboard",
      },
      longText: "x".repeat(600),
      items: Array.from({ length: 140 }, (_, index) => ({ index })),
    }) as Record<string, unknown>;

    expect(redacted.credentialRef).toBe("provider:opaque-ref");
    expect(redacted.nested).toEqual({});
    expect(redacted.longText).toBe(`${"x".repeat(512)}…`);
    expect(redacted.items).toHaveLength(128);
    expect(JSON.stringify(redacted)).not.toContain("must-not-enter-dashboard");
  });

  test("sanitizes attacker-controlled error text before it reaches operator state", () => {
    expect(sanitizeErrorMessage("authorization: Bearer top-secret", "request failed")).toBe("request failed");
    expect(() => unwrapDaemonEnvelope({ data: null, error: { code: "provider.error", message: "provider_response: top-secret" } })).toThrowError(
      expect.objectContaining({ message: "daemon request failed" }),
    );
  });

  test("reports degraded daemon state without treating it as transport failure", () => {
    const result = normalizeDashboardSummary(unwrapDaemonEnvelope(daemonDegradedFixture));
    expect(result.health.status).toBe("degraded");
    expect(daemonFailure(new ApiError(503, "unavailable", "cache unavailable"))).toEqual({ code: "unavailable", message: "cache unavailable", degraded: true });
  });

  test("rejects malformed envelopes with a stable contract code", () => {
    expect(() => unwrapDaemonEnvelope({ nope: true })).toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });

  test("targets the daemon admin route and sends JSON mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await daemonApi("/settings", { method: "PATCH", body: JSON.stringify({ logLevel: "info" }) });
    expect(fetchMock).toHaveBeenCalledWith("/console/api/v2/admin/settings", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ logLevel: "info" }) }));
  });
});
