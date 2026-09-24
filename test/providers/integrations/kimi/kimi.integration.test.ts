import { describe, expect, test } from "bun:test";
import { KimiCodeOAuthClient, getKimiCommonHeaders, parseKimiCredential } from "../../../../src/providers/integrations/kimi/kimi-oauth";
import type { CanonicalRequest } from "../../../../src/transport/canonical-model";
import type { ProviderDispatchTarget, ProviderDispatchContext } from "../../../../src/providers/provider-registry";
import { createKimiCodeAdapter, lookupKimiModelBootstrap, lookupKimiPromptCacheKey, lookupKimiTokenizer } from "../../../../src/providers/integrations/kimi/kimi";
import { jsonResponse } from "../../../helpers/sse-fixtures";

describe("Kimi Integration", () => {
  describe("kimi-oauth.test.ts", () => {

describe("Kimi Code OAuth", () => {
  test("keeps one device identity from device authorization through persisted credential", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    let call = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headerBag = new Headers(init?.headers);
      const headers = {
        "x-msh-device-id": headerBag.get("X-Msh-Device-Id") ?? "",
      };
      requests.push({ url: String(input), headers });
      call += 1;
      if (call === 1) {
        return jsonResponse({
          device_code: "device-code-1",
          user_code: "ABCD-1234",
          verification_uri_complete: "https://kimi.example/device?code=ABCD-1234",
          interval: 2,
          expires_in: 600,
        });
      }
      return jsonResponse({
        access_token: "access-token-1",
        refresh_token: "refresh-token-1",
        expires_in: 3600,
        user_id: "user-1",
      });
    }) as typeof fetch;
    const client = new KimiCodeOAuthClient(fetcher);

    const started = await client.startDeviceAuth();
    const polled = await client.pollDeviceAuth(started.deviceAuthId, {
      providerId: "kimi",
      tenantId: "tenant-a",
      accountLabel: "account-a",
      providerState: started.providerState,
    });

    expect(started.providerState).toBeTruthy();
    expect(requests[0]?.headers["x-msh-device-id"]).toBe(started.providerState);
    expect(requests[1]?.headers["x-msh-device-id"]).toBe(started.providerState);
    expect(polled.status).toBe("complete");
    if (polled.status !== "complete") return;
    const credential = parseKimiCredential(polled.result.access);
    expect(credential.accessToken).toBe("access-token-1");
    expect(credential.deviceId).toBe(started.providerState);
    expect(JSON.parse(polled.result.refresh)).toEqual({
      refreshToken: "refresh-token-1",
      deviceId: started.providerState,
    });
  });

  test("generates distinct explicit device identities for separate accounts", () => {
    const one = getKimiCommonHeaders("tenant-a-device");
    const two = getKimiCommonHeaders("tenant-b-device");
    expect(one["X-Msh-Device-Id"]).toBe("tenant-a-device");
    expect(two["X-Msh-Device-Id"]).toBe("tenant-b-device");
    expect(one["X-Msh-Device-Id"]).not.toBe(two["X-Msh-Device-Id"]);
  });
});
  });

  describe("kimi.test.ts", () => {
const request = (overrides: Partial<CanonicalRequest> = {}): CanonicalRequest => ({
  model: "k3",
  messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
  generation_controls: { max_tokens: 1024 },
  stream: false,
  source_surface: "messages",
  ...overrides,
});

const candidate: ProviderDispatchTarget = {
  provider_id: "kimi",
  model_id: "k3",
  wire_family: "messages",
  endpoint_path: "/v1/messages",
  capabilities: {},
};

function context(): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "kimi",
      credential_kind: "oauth",
      secret: new TextEncoder().encode(
        JSON.stringify({ accessToken: "access-token", deviceId: "account-device" }),
      ),
    },
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
  };
}

describe("Kimi Code adapter", () => {
  test("uses the Anthropic-compatible Messages path and preserves prompt-cache markers", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      const headerBag = new Headers(init?.headers);
      seenHeaders = {
        authorization: headerBag.get("Authorization") ?? "",
        "x-msh-device-id": headerBag.get("X-Msh-Device-Id") ?? "",
      };
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "msg_1",
          model: "k3",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const adapter = createKimiCodeAdapter({
      baseUrl: "https://api.kimi.test/coding",
      fetch: fetcher,
    });
    const events = [];
    for await (const event of adapter.dispatch(
      request({
        cache_hint: "stable_prefix",
        generation_controls: {
          max_tokens: 1024,
          "extension:prompt_cache_key": "tenant-a-cache",
        },
      }),
      candidate,
      context(),
    )) {
      events.push(event);
    }

    expect(seenUrl).toBe("https://api.kimi.test/coding/v1/messages");
    expect(seenHeaders.authorization).toBe("Bearer access-token");
    expect(seenHeaders["x-msh-device-id"]).toBe("account-device");
    expect(seenBody.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ cache_control: expect.anything() }),
          ]),
        }),
      ]),
    );
    expect(seenBody.metadata).toEqual({ user_id: "tenant-a-cache" });
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete" });
  });

  test("exposes bootstrap tokenizer and prompt-cache metadata per model", () => {
    expect(lookupKimiModelBootstrap("kimi-k2")).toEqual({
      tokenizer: "kimi-k2",
      supportsPromptCache: true,
      alwaysSendMaxTokens: true,
      maxOutputTokens: 262_144,
    });
    expect(lookupKimiTokenizer("kimi-k2")).toBe("kimi-k2");
    expect(lookupKimiPromptCacheKey(request({ generation_controls: {} }))).toBeUndefined();
  });
});
  });

});
