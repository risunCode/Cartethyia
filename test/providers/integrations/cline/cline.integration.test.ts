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
      verificationUri: "https://app.workos.com/device",
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
  test("keeps the current free Cline roster in the builtin catalog", () => {
    expect(CLINE_MODELS.map((model) => model.modelId)).toEqual([
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "google/gemma-4-31b-it:free",
      "deepseek/deepseek-v4-flash",
      "cline-free/deepseek-v4.1-flash",
      "z-ai/glm-5.3-flash",
      "cline-free/muse-spark-1.3-contributor",
    ]);
    expect(CLINE_MODELS.every((model) => model.cost.input === 0 && model.cost.output === 0)).toBe(true);
  });

  test("workosToken helper correctly applies prefix", () => {
    expect(workosToken("abc")).toBe("workos:abc");
    expect(workosToken("workos:abc")).toBe("workos:abc");
  });

  test("fetches paid and free recommended models with separate wire namespaces", async () => {
    const models = await fetchClineRecommendedModels(undefined, true, async () =>
      new Response(
        JSON.stringify({
          clinePass: [{ id: "glm-5.3-flash" }],
          free: [{ id: "z-ai/glm-5.3-flash" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    expect(models?.map((model) => model.modelId)).toEqual([
      "cline-pass/glm-5.3-flash",
      "z-ai/glm-5.3-flash",
    ]);
  });
});
  });

});
