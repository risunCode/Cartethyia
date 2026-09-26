import { describe, expect, test } from "bun:test";
import { ClineOAuthClient } from "../../../../src/providers/integrations/cline/cline-oauth";
import type { ResolvedCredential } from "../../../../src/providers/provider-registry";
import { candidateFor, canonicalRequest, dispatchContext, dispatchJson } from "../../../helpers/provider-dispatch";
import { CLINE_MODELS, createClineAdapter, fetchClineRecommendedModels, getClineClientVersion, getClineSdkVersion, workosToken } from "../../../../src/providers/integrations/cline/cline";
import { jsonResponse } from "../../../helpers/sse-fixtures";

describe("Cline Integration", () => {
  describe("cline-oauth.test.ts", () => {

function requestBody(init?: RequestInit): string {
  if (init?.body instanceof URLSearchParams) return init.body.toString();
  return String(init?.body ?? "");
}

describe("Cline WorkOS device OAuth", () => {
  test("starts, polls pending, registers completed WorkOS tokens, and refreshes", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      switch (calls.length) {
        case 1:
          return jsonResponse({
            device_code: "device-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://app.workos.com/device",
            // WorkOS returns a complete URI carrying the code; the flow must
            // publish this one so the operator does not retype the code.
            verification_uri_complete: "https://app.workos.com/device?user_code=ABCD-EFGH",
            interval: 7,
            expires_in: 240,
          });
        case 2:
          return jsonResponse({ error: "authorization_pending" }, 400);
        case 3:
          return jsonResponse({
            access_token: "workos-access",
            refresh_token: "workos-refresh",
            expires_in: 3600,
          });
        case 4:
          return jsonResponse({
            data: {
              accessToken: "cline-access",
              refreshToken: "cline-refresh",
              expiresAt: "2030-01-01T00:00:00.000Z",
              email: "user@example.com",
            },
          });
        default:
          return jsonResponse({
            accessToken: "refreshed-access",
            refreshToken: "refreshed-refresh",
            expiresIn: 3600,
          });
      }
    }) as unknown as typeof fetch;

    const client = new ClineOAuthClient(fetcher);
    const started = await client.startDeviceAuth();
    const pending = await client.pollDeviceAuth(started.deviceAuthId);
    const restartedClient = new ClineOAuthClient(fetcher);
    const complete = await restartedClient.pollDeviceAuth(started.deviceAuthId, {
      providerId: "cline",
      tenantId: null,
      accountLabel: "cline",
      providerState: started.providerState,
    });

    expect(started).toMatchObject({
      deviceAuthId: "device-1",
      userCode: "ABCD-EFGH",
      // The complete URI, so opening the page enters the code automatically.
      // Publishing the bare `verification_uri` made the operator read the code
      // here and type it into the form by hand.
      verificationUri: "https://app.workos.com/device?user_code=ABCD-EFGH",
      intervalSeconds: 7,
      expiresInSeconds: 240,
    });
    expect(pending).toEqual({ status: "pending" });
    expect(complete).toMatchObject({
      status: "complete",
      result: {
        access: "cline-access",
        refresh: "cline-refresh",
        accountLabel: "user@example.com",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    const refreshed = await restartedClient.refresh(
      complete.status === "complete" ? complete.result.refresh : "cline-refresh",
    );
    expect(refreshed).toMatchObject({
      access: "refreshed-access",
      refresh: "refreshed-refresh",
    });

    expect(calls[0]?.url).toBe("https://api.workos.com/user_management/authorize/device");
    expect(requestBody(calls[0]?.init)).toContain("client_id=client_01K3A541FN8TA3EPPHTD2325AR");
    expect(calls[1]?.url).toBe("https://api.workos.com/user_management/authenticate");
    expect(requestBody(calls[1]?.init)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
    expect(requestBody(calls[1]?.init)).toContain("device_code=device-1");
    expect(calls[2]?.url).toBe("https://api.workos.com/user_management/authenticate");
    expect(calls[3]?.url).toBe("https://api.cline.bot/api/v1/auth/register");
    expect(requestBody(calls[3]?.init)).toBe(
      JSON.stringify({ accessToken: "workos-access", refreshToken: "workos-refresh" }),
    );
    expect(calls[4]?.url).toBe("https://api.cline.bot/api/v1/auth/refresh");
    expect(requestBody(calls[4]?.init)).toBe(
      JSON.stringify({ refreshToken: "cline-refresh", grantType: "refresh_token" }),
    );
  });

  test("returns failed for an unknown or expired device session", async () => {
    const client = new ClineOAuthClient((async () => jsonResponse({})) as unknown as typeof fetch);
    await expect(client.pollDeviceAuth("missing-device")).resolves.toEqual({
      status: "failed",
      reason: "Cline device authorization expired",
    });
  });
});
  });

  describe("cline.test.ts", () => {
function dispatch(credential: Partial<ResolvedCredential>, model = "test-model") {
  return dispatchJson({
    create: createClineAdapter,
    candidate: candidateFor("cline", "chat", "/chat/completions", model),
    request: canonicalRequest({ model }),
    context: dispatchContext("cline", credential),
  });
}

describe("Cline adapter authentication & header policy", () => {
  test("Bearer token shape follows the credential kind", async () => {
    const rows: readonly { readonly kind: ResolvedCredential["credential_kind"]; readonly secret: string; readonly expected: string }[] = [
      { kind: "api_key", secret: "direct-token", expected: "Bearer direct-token" },
      { kind: "oauth", secret: "oauth-token-123", expected: "Bearer workos:oauth-token-123" },
      { kind: "oauth", secret: "workos:already-prefixed", expected: "Bearer workos:already-prefixed" },
      { kind: "scoped_access_token", secret: "scoped-tok", expected: "Bearer workos:scoped-tok" },
      { kind: "oauth", secret: "Bearer wrapped-token", expected: "Bearer workos:wrapped-token" },
    ];

    for (const row of rows) {
      const captured = await dispatch({
        credential_kind: row.kind,
        secret: new TextEncoder().encode(row.secret),
      });

      expect(captured.headers["authorization"]).toBe(row.expected);
      expect(captured.headers["x-client-version"]).toBe(getClineClientVersion());
      expect(captured.headers["x-core-version"]).toBe(getClineSdkVersion());
      expect(captured.headers["x-client-type"]).toBe("cline-sdk");
      expect(captured.headers["http-referer"]).toContain("https://cline.bot");
    }
  });
});

describe("Cline adapter payload & quirk handling", () => {
  test("prepends a non-empty system prompt when request lacks system/developer message", async () => {
    const captured = await dispatch({});

    const messages = captured.body["messages"] as Array<{ role: string; content: unknown }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe("You are a helpful assistant.");
  });

  test("repairs an existing empty system message", async () => {
    const input = canonicalRequest({ model: "test-model" });
    const captured = await dispatchJson({
      create: createClineAdapter,
      candidate: candidateFor("cline", "chat", "/chat/completions"),
      request: { ...input, messages: [{ role: "system", content: [] }, ...input.messages] },
      context: dispatchContext("cline"),
    });

    const messages = captured.body["messages"] as Array<{ role: string; content: unknown }>;
    expect(messages[0]?.content).toBe("You are a helpful assistant.");
  });

  test("deepseek-v4-flash non-streaming is coerced to streaming with reasoning_effort=none", async () => {
    const captured = await dispatch({}, "deepseek/deepseek-v4-flash");

    expect(captured.body["stream"]).toBe(true);
    expect(captured.body["reasoning_effort"]).toBe("none");
    expect(typeof captured.body["max_tokens"]).toBe("number");
    expect((captured.body["max_tokens"] as number) >= 256).toBe(true);
  });
});

describe("Cline model catalog", () => {
  test("seeds only ids the free tier currently serves, and keeps them free", () => {
    // This list owns the builtin rows: `seedBundledModels` deletes a builtin
    // row the list no longer declares, so an id Cline has retired would
    // otherwise stay in the catalog — and stay routable — forever. The live
    // roster is the authority; this pins the seed against it.
    expect(CLINE_MODELS.map((model) => model.modelId)).toEqual([
      "deepseek/deepseek-v4-flash",
      "cline-free/deepseek-v4.1-flash",
      "z-ai/glm-5.3-flash",
      "cline-free/muse-spark-1.3-contributor",
    ]);
    expect(CLINE_MODELS.every((model) => model.cost.input === 0 && model.cost.output === 0)).toBe(true);
  });

  test("does not seed the two ids Cline's free roster dropped", () => {
    // Regression pin for the reported bug: both ids were seeded here while
    // Cline served neither on the free tier, so each rendered as a builtin
    // card whose every probe could only fail, and — because nothing prunes a
    // builtin row the list still declares — neither could be deleted from the
    // dashboard. Cline's live roster is the authority; a network check is not
    // possible from a unit test, so this pins the removal itself.
    for (const id of ["nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemma-4-31b-it:free"]) {
      expect(CLINE_MODELS.some((model) => model.modelId === id)).toBe(false);
    }
  });

  test("marks the free bucket as the free tier, and only that bucket", async () => {
    // The `free` bucket is the tier; `recommended` is not, even though a pass
    // account receives both. The marker is what `syncModels` turns into
    // `source: "auto_free"`, so a wrong bucket here misfiles rows in the model
    // list rather than merely mislabelling a badge.
    const models = await fetchClineRecommendedModels(undefined, true, async () =>
      new Response(
        JSON.stringify({
          recommended: [{ id: "anthropic/claude-opus-5" }],
          free: [{ id: "stealth/pixel-canary" }],
          clinePass: [{ id: "cline-pass/kimi-k3" }],
          clineCloud: [{ id: "cline-cloud/glm-5.3" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const tierOf = (id: string) => models?.find((model) => model.modelId === id)?.freeTier === true;

    expect(tierOf("stealth/pixel-canary")).toBe(true);
    expect(tierOf("anthropic/claude-opus-5")).toBe(false);
    expect(tierOf("cline-pass/kimi-k3")).toBe(false);
    expect(tierOf("cline-cloud/glm-5.3")).toBe(false);
  });

  test("the free tier is the bucket, not the id prefix", async () => {
    // Regression for a wrong rule: the `free` bucket serves ids with no
    // `cline-free/` prefix (`deepseek/deepseek-v4-flash`), so a prefix test
    // would drop a served model. The bucket decides, whatever the id looks
    // like — here an unprefixed id in `free` and a prefixed one in `clinePass`.
    const models = await fetchClineRecommendedModels(undefined, true, async () =>
      new Response(
        JSON.stringify({
          free: [{ id: "deepseek/deepseek-v4-flash" }],
          clinePass: [{ id: "cline-pass/deepseek-v4.1-flash" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const tierOf = (id: string) => models?.find((model) => model.modelId === id)?.freeTier === true;

    expect(tierOf("deepseek/deepseek-v4-flash")).toBe(true);
    expect(tierOf("cline-pass/deepseek-v4.1-flash")).toBe(false);
  });

  test("workosToken helper correctly applies prefix", () => {
    expect(workosToken("abc")).toBe("workos:abc");
    expect(workosToken("workos:abc")).toBe("workos:abc");
  });

  test("keeps the endpoint's own id spelling instead of double-namespacing it", async () => {
    // The live endpoint already namespaces its ids (`cline-pass/…`,
    // `cline-cloud/…`, `cline-free/…`). Prefixing again produced
    // `cline-pass/cline-pass/glm-5.3-flash`, which no upstream route resolves.
    const models = await fetchClineRecommendedModels(undefined, true, async () =>
      new Response(
        JSON.stringify({
          recommended: [{ id: "spacexai/grok-4.7" }],
          free: [{ id: "cline-free/gemini-3.8-flash" }],
          clinePass: [{ id: "cline-pass/glm-5.3-flash" }],
          clineCloud: [{ id: "cline-cloud/glm-5.3" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    expect(models?.map((model) => model.modelId)).toEqual([
      "spacexai/grok-4.7",
      "cline-free/gemini-3.8-flash",
      "cline-pass/glm-5.3-flash",
      "cline-cloud/glm-5.3",
    ]);
  });

  test("reads every bucket the endpoint publishes, and only for a pass account", async () => {
    // `recommended` and `clineCloud` were dropped entirely: reading only
    // `free`/`clinePass` hid both from the catalog.
    const payload = {
      recommended: [{ id: "spacexai/grok-4.7" }],
      free: [{ id: "cline-free/gemini-3.8-flash" }],
      clinePass: [{ id: "cline-pass/glm-5.3-flash" }],
      clineCloud: [{ id: "cline-cloud/glm-5.3" }],
    };
    const fetcher = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const pass = await fetchClineRecommendedModels(undefined, true, fetcher);
    expect(pass?.map((m) => m.modelId)).toEqual([
      "spacexai/grok-4.7",
      "cline-free/gemini-3.8-flash",
      "cline-pass/glm-5.3-flash",
      "cline-cloud/glm-5.3",
    ]);
    // A non-pass account sees the free tier only; the subscription and cloud
    // rosters are not routable for it.
    const free = await fetchClineRecommendedModels(undefined, false, fetcher);
    expect(free?.map((m) => m.modelId)).toEqual([
      "spacexai/grok-4.7",
      "cline-free/gemini-3.8-flash",
    ]);
  });

  test("takes limits from the base catalog rather than a fixed 200k/64k", async () => {
    // The roster reports no limits (id/name/description/tags only), so a
    // hardcoded 200_000/64_192 was wrong for most of the roster: the pass
    // entries are 1M-context. `cline-pass/kimi-k3` is filed as 1048576/131072.
    const models = await fetchClineRecommendedModels(undefined, true, async () =>
      new Response(JSON.stringify({ clinePass: [{ id: "cline-pass/kimi-k3" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const kimi = models?.find((m) => m.modelId === "cline-pass/kimi-k3");
    expect(kimi?.contextLimit).toBe(1_048_576);
    expect(kimi?.outputLimit).toBe(131_072);
    // Never above the context window: an output cap the model cannot satisfy.
    expect(kimi!.outputLimit!).toBeLessThanOrEqual(kimi!.contextLimit!);
  });

  test("prefers Cline's own catalog limits over any guess", async () => {
    // `/ai/cline/models` states `context_length` and
    // `top_provider.max_completion_tokens` for the id it serves, and that is
    // the serving provider's own answer. The two endpoints disagree on
    // spelling, so the lookup also tries the bare segment: the roster calls it
    // `cline-pass/kimi-k3` while the catalog files it as `moonshotai/kimi-k3`.
    const models = await fetchClineRecommendedModels(undefined, true, async (input) => {
      const url = String(input);
      if (url.includes("/recommended-models"))
        return new Response(JSON.stringify({ clinePass: [{ id: "cline-pass/kimi-k3" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "moonshotai/kimi-k3",
              context_length: 262_144,
              top_provider: { max_completion_tokens: 32_768 },
              architecture: { input_modalities: ["text", "image"] },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const kimi = models?.find((m) => m.modelId === "cline-pass/kimi-k3");
    // Upstream's own numbers, not the base catalog's 1048576/131072.
    expect(kimi?.contextLimit).toBe(262_144);
    expect(kimi?.outputLimit).toBe(32_768);
    // `input_modalities` is authoritative for vision when it lists the id.
    expect(kimi?.modalities.input).toContain("image");
  });

  test("falls back to the base catalog when the upstream catalog is unavailable", async () => {
    // The roster is still useful without limits, so a failed sibling fetch must
    // not fail the roster; `defineModel` supplies the numbers instead.
    const models = await fetchClineRecommendedModels(undefined, true, async (input) => {
      const url = String(input);
      if (url.includes("/recommended-models"))
        return new Response(JSON.stringify({ clinePass: [{ id: "cline-pass/kimi-k3" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      return new Response("nope", { status: 503 });
    });
    const kimi = models?.find((m) => m.modelId === "cline-pass/kimi-k3");
    expect(kimi?.contextLimit).toBe(1_048_576);
    expect(kimi?.outputLimit).toBe(131_072);
  });
});
  });

});
