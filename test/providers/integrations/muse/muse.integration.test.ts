import { describe, expect, test } from "bun:test";
import { MuseCodeOAuthClient } from "../../../../src/providers/integrations/muse/muse-oauth";
import { createMuseCodeAdapter, parseMuseCodeCredential } from "../../../../src/providers/integrations/muse/muse";
import type { CanonicalRequest } from "../../../../src/transport/canonical-model";
import type { ProviderDispatchTarget, ProviderDispatchContext } from "../../../../src/providers/provider-registry";
import { jsonResponse } from "../../../helpers/sse-fixtures";

describe("Muse Integration", () => {
  describe("muse-oauth.test.ts", () => {

describe("Muse Code OAuth", () => {
  test("device flow mints the subscription key and returns an OAuth envelope", async () => {
    const urls: string[] = [];
    let call = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      call += 1;
      if (call === 1) {
        return jsonResponse({
          device_code: "device-code-1",
          user_code: "ABCD-1234",
          verification_uri_complete: "https://meta.example/device?code=ABCD-1234",
          interval: 1,
          expires_in: 600,
        });
      }
      if (call === 2) {
        return jsonResponse({ access_token: "oauth-token" });
      }
      return jsonResponse({
        api_key: "subscription-key",
        user_id: "meta-user-1",
        is_subs_active: true,
      });
    }) as typeof fetch;
    const client = new MuseCodeOAuthClient(fetcher);

    const started = await client.startDeviceAuth();
    const result = await client.pollDeviceAuth(started.deviceAuthId);

    expect(urls).toEqual([
      "https://auth.meta.com/oidc/device/authorization/",
      "https://auth.meta.com/oidc/device/token/",
      "https://api.meta.ai/muse-code/key",
    ]);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(parseMuseCodeCredential(result.result.access)).toEqual({
      oauthAccessToken: "oauth-token",
      apiKey: "subscription-key",
    });
    expect(result.result.refresh).toBe("oauth-token");
    expect(result.result.accountLabel).toBe("meta-user-1");
  });

  test("pending device authorization remains retryable", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({
          device_code: "device-code-2",
          user_code: "EFGH-5678",
          verification_uri: "https://meta.example/device",
        });
      }
      return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
    }) as unknown as typeof fetch;
    const client = new MuseCodeOAuthClient(fetcher);
    const started = await client.startDeviceAuth();
    const result = await client.pollDeviceAuth(started.deviceAuthId);
    expect(result).toEqual({ status: "pending" });
  });
});
  });

  describe("muse.test.ts", () => {
const request: CanonicalRequest = {
  model: "muse-spark-1.2",
  messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
  generation_controls: { max_output_tokens: 1024 },
  stream: false,
  source_surface: "responses",
};

const candidate: ProviderDispatchTarget = {
  provider_id: "muse",
  model_id: "muse-spark-1.2",
  wire_family: "responses",
  endpoint_path: "/v1/responses",
  capabilities: {},
};

const context: ProviderDispatchContext = {
  credential: {
    provider_id: "muse",
    credential_kind: "oauth",
    secret: new TextEncoder().encode(
      JSON.stringify({ oauthAccessToken: "oauth-token", apiKey: "subscription-key" }),
    ),
  },
  deadline: Date.now() + 10_000,
  abort_signal: new AbortController().signal,
};

describe("Muse Code adapter", () => {
  test("uses the v1 Responses endpoint with the minted subscription key", async () => {
    let seenUrl = "";
    let seenAuthorization = "";
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuthorization = new Headers(init?.headers).get("Authorization") ?? "";
      return new Response(
        JSON.stringify({
          id: "resp_1",
          model: "muse-spark-1.2",
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "done" }],
            },
          ],
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const adapter = createMuseCodeAdapter({
      baseUrl: "https://api.meta.test",
      fetch: fetcher,
    });
    const events = [];
    for await (const event of adapter.dispatch(request, candidate, context)) events.push(event);

    expect(seenUrl).toBe("https://api.meta.test/v1/responses");
    expect(seenAuthorization).toBe("Bearer subscription-key");
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete" });
  });
});
  });

});
