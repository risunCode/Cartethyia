import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchGrokQuota } from "../../../../src/providers/integrations/grok/grok-quota";
import { GROK_CLIENT_ID, GROK_SCOPE, GrokOAuthClient } from "../../../../src/providers/integrations/grok/grok-oauth";
import { VERSION_SOURCES } from "../../../../src/providers/operations/client-versions";
import type { CanonicalRequest } from "../../../../src/transport/canonical-model";
import type { ProviderDispatchTarget, ProviderDispatchContext } from "../../../../src/providers/provider-registry";
import { GROK_MODELS, createGrokAdapter } from "../../../../src/providers/integrations/grok/grok";
import { _resetGrokVersionCache } from "../../../../src/providers/operations/client-versions";
import { _resetGrokTurnIndexForTests } from "../../../../src/providers/integrations/grok/grok-turn-index";
import { jsonResponse } from "../../../helpers/sse-fixtures";

describe("Grok Integration", () => {
  // Seed the client version so request contracts are asserted against a
  // fixed value. Seeding also stops background discovery during the suite.
  beforeEach(() => {
    _resetGrokVersionCache(VERSION_SOURCES.grok.fallback);
  });
  afterEach(() => {
    _resetGrokVersionCache();
  });
  describe("grok-quota.test.ts", () => {

describe("Grok billing", () => {
  test("parses credits, product usage, on-demand caps, and subscription tier", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      if (String(input).includes("billing")) {
        expect(new Headers(init?.headers).get("X-XAI-Token-Auth")).toBe("xai-grok-cli");
        return jsonResponse({
          currentPeriod: {
            start: "2026-09-01T00:00:00Z",
            end: "2026-09-08T00:00:00Z",
            type: "WEEKLY",
          },
          creditUsagePercent: 25,
          productUsage: [{ product: "GrokBuild", usagePercent: 40 }],
          onDemandCap: { val: 100 },
          onDemandUsed: { val: 5 },
        });
      }
      return jsonResponse({ subscriptionTier: "SuperGrok" });
    }) as typeof fetch;

    const result = await fetchGrokQuota("access-token", fetcher);

    expect(calls).toEqual([
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      "https://cli-chat-proxy.grok.com/v1/user?include=subscription",
    ]);
    expect(result.plan).toBe("SuperGrok");
    expect(result.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "SuperGrok Weekly Credits", usedPercent: 25 }),
        expect.objectContaining({ label: "GrokBuild (Weekly)", usedPercent: 40 }),
        expect.objectContaining({ label: "On-demand", used: 5, limit: 100 }),
      ]),
    );
  });

  test("falls back to unified monthly billing", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).includes("billing")) {
        return jsonResponse({
          billingPeriodStart: "2026-09-01T00:00:00Z",
          billingPeriodEnd: "2026-10-01T00:00:00Z",
          monthlyLimit: { val: 1000 },
          used: { val: 125 },
        });
      }
      return jsonResponse({ user: { subscriptionTier: "Unified" } });
    }) as typeof fetch;

    const result = await fetchGrokQuota("access-token", fetcher);
    expect(result.plan).toBe("Unified");
    expect(result.windows).toEqual([
      expect.objectContaining({
        label: "SuperGrok Monthly Included",
        usedPercent: 12.5,
        used: 125,
        limit: 1000,
      }),
    ]);
  });

  test("parses the live free-tier config envelope with a dateless percent", async () => {
    const seenVersions: Array<string | null> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("billing")) {
        const headers = new Headers(init?.headers);
        seenVersions.push(headers.get("x-grok-client-version"));
        return jsonResponse({
          config: {
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              start: "2026-09-08T00:00:00+00:00",
              end: "2026-09-15T00:00:00+00:00",
            },
            onDemandCap: { val: 0 },
            onDemandUsed: { val: 0 },
            isUnifiedBillingUser: true,
            prepaidBalance: { val: 0 },
            billingPeriodStart: "2026-09-08T00:00:00+00:00",
            billingPeriodEnd: "2026-09-15T00:00:00+00:00",
          },
        });
      }
      return jsonResponse({});
    }) as typeof fetch;

    const result = await fetchGrokQuota("access-token", fetcher);
    // Every xAI-bound request carries the single-sourced client version.
    expect(seenVersions).toEqual([VERSION_SOURCES.grok.fallback]);
    // Period known, percent unknown: one honest window with the reset date,
    // no fabricated numbers — this is what renders on the quota page.
    expect(result.windows).toEqual([
      expect.objectContaining({
        kind: "1w",
        label: "SuperGrok Weekly Credits",
        usedPercent: null,
        remainingPercent: null,
        resetsAt: "2026-09-15T00:00:00.000Z",
      }),
    ]);
  });
});
  });

  describe("grok.test.ts", () => {
function responseSse(): Response {
  const events = [
    {
      type: "response.created",
      response: {
        status: "in_progress",
        usage: {
          input_tokens: 145720,
          input_tokens_details: { cached_tokens: 145592 },
        },
      },
    },
    {
      type: "response.in_progress",
      response: {
        usage: { input_tokens_details: { cached_tokens: 145592 } },
      },
    },
    { type: "response.output_text.delta", delta: "hello" },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage: {
          input_tokens: 145720,
          output_tokens: 1,
          input_tokens_details: { cached_tokens: 128 },
        },
      },
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function request(): CanonicalRequest {
  return {
    model: "grok-4.6",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    reasoning: { effort: "high" },
    stream: false,
    source_surface: "responses",
    conversation: { conversation_id: "conversation-1" },
  };
}

const candidate: ProviderDispatchTarget = {
  provider_id: "grok",
  model_id: "grok-4.6",
  wire_family: "responses",
  endpoint_path: "/v1/responses",
  capabilities: {},
};

function context(
  credentialKind: "oauth" | "api_key" = "oauth",
): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "grok",
      credential_kind: credentialKind,
      secret: new TextEncoder().encode("access-token"),
    },
    request_headers: { "x-session-id": "session-1" },
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
  };
}

describe("Grok CLI adapter", () => {
  test("sends CLI Responses headers, stable session, encrypted reasoning, and forced SSE", async () => {
    let seenUrl = "";
    let seenHeaders = new Headers();
    let seenBody: Record<string, unknown> = {};
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseSse();
    }) as typeof fetch;
    const adapter = createGrokAdapter({ fetch: fetcher });
    const events = [];
    for await (const event of adapter.dispatch(request(), candidate, context())) events.push(event);

    expect(seenUrl).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(seenHeaders.get("authorization")).toBe("Bearer access-token");
    expect(seenHeaders.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(seenHeaders.get("x-grok-model-override")).toBe("grok-4.6");
    expect(seenHeaders.get("x-grok-session-id")).toBe("conversation-1");
    expect(seenHeaders.get("x-grok-conv-id")).toBe("conversation-1");
    expect(seenHeaders.get("x-grok-turn-idx")).toBe("1");
    expect(seenHeaders.get("accept-encoding")).toBe("identity");
    expect(seenBody.model).toBe("grok-4.6");
    expect(seenBody.stream).toBe(true);
    expect(seenBody.store).toBe(false);
    expect(seenBody.include).toEqual(["reasoning.encrypted_content"]);
    const terminal = events.find((event) => event.type === "terminal");
    expect(terminal?.type === "terminal" ? terminal.usage : undefined).toMatchObject({
      input_tokens: 145720,
      cached_input_tokens: 145592,
    });
    expect(seenBody.reasoning).toEqual({ summary: "concise", effort: "high" });
    expect(GROK_MODELS.find((model) => model.modelId === "grok-4.5")?.contextLimit).toBe(
      GROK_MODELS.find((model) => model.modelId === "grok-4.6")?.contextLimit,
    );
    expect(GROK_MODELS.find((model) => model.modelId === "grok-4.5")?.outputLimit).toBe(
      GROK_MODELS.find((model) => model.modelId === "grok-4.6")?.outputLimit,
    );
  });

  test("rejects API-key credentials because Grok CLI is subscription OAuth-only", async () => {
    const fetcher = (async () => responseSse()) as unknown as typeof fetch;
    const adapter = createGrokAdapter({ fetch: fetcher });
    await expect(
      (async () => {
        for await (const _event of adapter.dispatch(request(), candidate, context("api_key"))) {
          // consume
        }
      })(),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("advances x-grok-turn-idx across turns of one session", async () => {
    // A delta-style client sends only the newest message, so the payload count
    // stays at 1; the header must still advance or the backend re-runs the
    // same turn. A regressing/static index is what the fix removes.
    _resetGrokTurnIndexForTests();
    const seen: string[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push(headers.get("x-grok-turn-idx") ?? "");
      return responseSse();
    }) as typeof fetch;
    const adapter = createGrokAdapter({ fetch: fetcher });
    const singleTurn = (): CanonicalRequest => ({
      ...request(),
      messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    });

    for (let index = 0; index < 3; index += 1) {
      for await (const _event of adapter.dispatch(singleTurn(), candidate, context())) {
        // consume
      }
    }

    expect(seen).toEqual(["1", "2", "3"]);
  });

  test("an inbound x-grok-turn-idx header wins over the computed index", async () => {
    _resetGrokTurnIndexForTests();
    let seenTurn = "";
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenTurn = new Headers(init?.headers).get("x-grok-turn-idx") ?? "";
      return responseSse();
    }) as typeof fetch;
    const adapter = createGrokAdapter({ fetch: fetcher });
    const dispatchContext = context();
    const withTurn = {
      ...dispatchContext,
      request_headers: { ...dispatchContext.request_headers, "x-grok-turn-idx": "7" },
    };

    for await (const _event of adapter.dispatch(request(), candidate, withTurn)) {
      // consume
    }

    expect(seenTurn).toBe("7");
  });
});

describe("Grok CLI OAuth", () => {
  test("completes device code, performs user lookup, and refreshes", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
    let count = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? ""),
      });
      count += 1;
      if (count === 1)
        return new Response(JSON.stringify({ device_code: "device-1", user_code: "ABCD-1234", verification_uri: "https://x.ai/device", interval: 5, expires_in: 900 }));
      if (count === 2) return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
      if (count === 3) return new Response(JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }));
      if (count === 4) return new Response(JSON.stringify({ email: "user@example.com" }));
      return new Response(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }));
    }) as typeof fetch;
    const client = new GrokOAuthClient(fetcher);

    const started = await client.startDeviceAuth();
    const pending = await client.pollDeviceAuth(started.deviceAuthId);
    const complete = await client.pollDeviceAuth(started.deviceAuthId);
    const refreshed = await client.refresh(complete.status === "complete" ? complete.result.refresh : "refresh-1");

    expect(started.userCode).toBe("ABCD-1234");
    expect(pending).toEqual({ status: "pending" });
    expect(complete).toMatchObject({ status: "complete", result: { access: "access-1", refresh: "refresh-1", accountLabel: "user@example.com" } });
    expect(refreshed).toMatchObject({ access: "access-2", refresh: "refresh-2" });
    expect(calls[0]?.body).toContain(`client_id=${GROK_CLIENT_ID}`);
    expect(calls[0]?.headers.get("x-grok-client-surface")).toBe("ui");
    expect(calls[0]?.headers.get("x-grok-client-version")).toBe(VERSION_SOURCES.grok.fallback);
    expect(calls[0]?.body).toContain("referrer=grok-build");
    expect(calls[0]?.body).toContain(encodeURIComponent(GROK_SCOPE).replace(/%20/g, "+"));
    expect(calls[3]?.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
  });
});
  });

});
