import { describe, expect, test } from "bun:test";
import {
  classifyUpstreamFailure,
  mapUpstreamHttpError,
  statusToGatewayErrorCode,
  upstreamRequestId,
} from "../../src/transport/failure-policy";
import type { GatewayError, GatewayErrorCode } from "../../src/transport/gateway-error";
import { mapCodexErrorResponse } from "../../src/providers/integrations/codex/codex-errors";

async function captureUpstreamError(response: Response): Promise<unknown> {
  try {
    await mapUpstreamHttpError(response, "test-provider");
    return undefined;
  } catch (error) {
    return error;
  }
}

async function captureAsync(fn: () => Promise<never>): Promise<GatewayError> {
  try {
    await fn();
    throw new Error("expected mapper to throw");
  } catch (error) {
    return error as GatewayError;
  }
}

describe("upstream error contract", () => {
  test("preserves bounded provider code, status, request id, and retry scope", async () => {
    const error = await captureUpstreamError(
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } }), {
        status: 429,
        headers: { "x-request-id": "provider-123" },
      }),
    );

    expect(error).toMatchObject({
      code: "quota_exceeded",
      status: 429,
      origin: "upstream",
      message: "slow down",
      details: {
        providerId: "test-provider",
        providerCode: "rate_limit_exceeded",
        providerStatus: 429,
        upstreamRequestId: "provider-123",
        rateLimitScope: "provider",
      },
    });
  });

  test("maps proxy authentication to the network origin", async () => {
    const error = await captureUpstreamError(
      new Response("proxy denied\nsecret-not-forwarded", { status: 407 }),
    );

    expect(error).toMatchObject({
      code: "proxy_auth_required",
      status: 407,
      origin: "network",
      details: { providerId: "test-provider", providerStatus: 407 },
    });
    expect(error).toMatchObject({
      details: { raw: expect.stringContaining("proxy denied") },
    });
  });

  const envelopes: Array<{ name: string; body: string; wantMessage: string }> = [
    {
      name: "error.message envelope",
      body: JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } }),
      wantMessage: "slow down",
    },
    {
      name: "error.code only envelope",
      body: JSON.stringify({ error: { code: "overloaded_error" } }),
      wantMessage: "overloaded_error",
    },
    {
      name: "top-level message",
      body: JSON.stringify({ message: "top level boom" }),
      wantMessage: "top level boom",
    },
    {
      name: "plain text with newline",
      body: "upstream blew up\nsecond line",
      wantMessage: "upstream blew up second line",
    },
  ];

  for (const { name, body, wantMessage } of envelopes) {
    test(`extracts the provider message from the error envelope: ${name}`, async () => {
      const error = (await captureUpstreamError(
        new Response(body, { status: 429 }),
      )) as GatewayError;
      expect(error.message).toBe(wantMessage);
    });
  }

  test("maps status to the gateway error code and origin", async () => {
    expect(statusToGatewayErrorCode(401)).toBe("authentication_failed");
    expect(statusToGatewayErrorCode(403)).toBe("authentication_failed");
    expect(statusToGatewayErrorCode(429)).toBe("quota_exceeded");
    expect(statusToGatewayErrorCode(407)).toBe("proxy_auth_required");
    // 5xx are an upstream platform outage. This used to resolve to
    // `proxy_unreachable` through a second, contradictory table, which the
    // dashboard renders as "network proxy was unreachable" — blaming the
    // egress proxy for the provider's own failure.
    expect(statusToGatewayErrorCode(500)).toBe("platform_unavailable");
    expect(statusToGatewayErrorCode(502)).toBe("platform_unavailable");
    expect(statusToGatewayErrorCode(503)).toBe("platform_unavailable");
    expect(statusToGatewayErrorCode(529)).toBe("capacity_exhausted");
    const cases: Array<{ status: number; code: GatewayErrorCode; origin: "upstream" | "network" }> = [
      { status: 400, code: "invalid_request", origin: "upstream" },
      { status: 401, code: "authentication_failed", origin: "upstream" },
      { status: 403, code: "authentication_failed", origin: "upstream" },
      { status: 407, code: "proxy_auth_required", origin: "network" },
      { status: 429, code: "quota_exceeded", origin: "upstream" },
      { status: 502, code: "platform_unavailable", origin: "upstream" },
    ];
    for (const { status, code, origin } of cases) {
      const error = (await captureUpstreamError(
        new Response("boom", { status }),
      )) as GatewayError;
      expect(error).toMatchObject({ code, status, origin });
    }
  });

  test("bounds the raw upstream body", async () => {
    const error = (await captureUpstreamError(
      new Response("x".repeat(600), { status: 500 }),
    )) as GatewayError;
    expect(error.details["raw"]).toHaveLength(500);
  });

  test("resolves the stable request-id header chain", async () => {
    for (const header of ["x-request-id", "request-id", "x-amzn-requestid", "cf-ray"] as const) {
      const headers = new Headers({ [header]: "rid-1" });
      expect(upstreamRequestId(headers)).toBe("rid-1");
      const error = (await captureUpstreamError(
        new Response("boom", { status: 500, headers }),
      )) as GatewayError;
      expect(error.details["upstreamRequestId"]).toBe("rid-1");
    }
  });

  test("preserves retry-after as cooldown evidence", async () => {
    const headers = new Headers({ "retry-after": "120" });
    const error = (await captureUpstreamError(
      new Response("slow down", { status: 429, headers }),
    )) as GatewayError;
    expect(error.details["retryAfterMs"]).toBe(120_000);
  });

  test("names a context-window overflow instead of leaving it a bare 400", async () => {
    // Upstreams report overflow under a generic 400. `invalid_request` told the
    // client its syntax was wrong and invited a byte-identical retry that could
    // never fit; the envelope status becomes 413 while `providerStatus` keeps
    // the literal upstream status for diagnostics.
    const error = (await captureUpstreamError(
      new Response(
        JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } }),
        { status: 400 },
      ),
    )) as GatewayError;
    expect(error).toMatchObject({ code: "context_length_exceeded", status: 413, origin: "upstream" });
    expect(error.details["providerStatus"]).toBe(400);
    // Deterministic request fault: retrying the same bytes cannot succeed.
    expect(classifyUpstreamFailure(error).retryable).toBe(false);
  });

  test("recognizes every structured overflow identifier the providers use", async () => {
    for (const code of ["context_length_exceeded", "context_too_large", "model_context_window_exceeded"]) {
      const error = (await captureUpstreamError(
        new Response(JSON.stringify({ error: { code } }), { status: 400 }),
      )) as GatewayError;
      expect(error.code).toBe("context_length_exceeded");
    }
  });

  test("does not guess context overflow from message prose", async () => {
    // An upstream may state overflow only in a sentence. Matching prose would
    // classify any message containing "too long" as an overflow — a substring
    // heuristic that misfires on client-authored text.
    const error = (await captureUpstreamError(
      new Response(
        JSON.stringify({ error: { type: "invalid_request_error", message: "prompt is too long" } }),
        { status: 400 },
      ),
    )) as GatewayError;
    expect(error).toMatchObject({ code: "invalid_request", status: 400 });
  });
});

// The Codex adapter keeps its own mapper (six `x-codex-*` rate-limit headers,
// usage-limit friendly overrides); this pins its observable contract.
describe("codex error mapper", () => {
  test("overrides rate-limit failures with a friendly message and preserves retry-after", async () => {
    const headers = new Headers({ "retry-after": "120" });
    const error = await captureAsync(() =>
      mapCodexErrorResponse(
        new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } }), {
          status: 429,
          headers,
        }),
      ),
    );
    expect(error.message).toMatch(/rate limit/i);
    expect(error.details["retryAfterMs"]).toBe(120_000);
  });

  test("preserves the extracted upstream message for non-rate-limit statuses", async () => {
    const error = await captureAsync(() =>
      mapCodexErrorResponse(
        new Response(JSON.stringify({ error: { code: "overloaded_error" } }), { status: 400 }),
      ),
    );
    expect(error.message).toBe("overloaded_error");
    expect(error).toMatchObject({ code: "invalid_request", status: 400, origin: "upstream" });
  });

  test("reports an upstream 5xx as a platform outage, not a client fault", async () => {
    // Codex used to pin every non-auth/rate/proxy status to `invalid_request`,
    // so an upstream 500 reached the client as "your request was invalid" and
    // telemetry recorded a client fault for a provider outage.
    const error = await captureAsync(() =>
      mapCodexErrorResponse(
        new Response(JSON.stringify({ error: { message: "upstream exploded" } }), { status: 503 }),
      ),
    );
    expect(error).toMatchObject({ code: "platform_unavailable", status: 503, origin: "upstream" });
  });
});
