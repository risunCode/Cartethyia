/**
 * The three OAuth-shaped providers each store a compound credential, and each
 * compound fact is load-bearing at dispatch: Factory Droid's org claim is a
 * header, Cloudflare's account/gateway slugs are URL path segments, Alibaba's
 * region is a different host. A secret forwarded verbatim instead of decoded
 * still produces a plausible request that fails upstream, so these drive the
 * real registry adapters and inspect the posted URL and headers.
 */
import { describe, expect, test } from "bun:test";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/contracts";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import { encodeAlibabaCodingPlanCredential } from "../../src/security/credential-codec";
import { encodeCloudflareAiGatewayCredential } from "../../src/security/credential-codec";
import { encodeFactoryDroidCredential } from "../../src/security/credential-codec";

const registry = createDefaultProviderRegistry();

interface Captured {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

const REQUEST = {
  model: "some-model",
  messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
  generation_controls: {},
} as unknown as CanonicalRequest;

function target(wireFamily: ProviderDispatchTarget["wire_family"], endpointPath: string): ProviderDispatchTarget {
  return {
    provider_id: "x",
    model_id: "some-model",
    wire_family: wireFamily,
    endpoint_path: endpointPath,
    capabilities: {},
  } as unknown as ProviderDispatchTarget;
}

/**
 * Dispatches and returns what was posted.
 *
 * `expectRequest: false` is for the cases that assert a rejection: those must
 * observe the throw itself, so the helper cannot assert the capture first.
 */
async function post(options: {
  readonly providerId: string;
  readonly secret: string;
  readonly candidate: ProviderDispatchTarget;
  readonly authState?: Record<string, unknown>;
  readonly expectRequest?: boolean;
}): Promise<Captured> {
  const adapter = await registry.resolve(options.providerId);
  expect(adapter).toBeDefined();
  let captured: Captured | undefined;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    captured = {
      url: String(url),
      headers,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    return new Response(
      'data: {"type":"message_start","message":{}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\ndata: {"type":"message_stop"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as unknown as typeof fetch;

  const stream = adapter!.dispatch(REQUEST, options.candidate, {
    credential: {
      provider_id: options.providerId,
      credential_kind: "api_key",
      secret: new TextEncoder().encode(options.secret),
      ...(options.authState === undefined ? {} : { auth_state: options.authState }),
    },
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher as never,
  } as unknown as ProviderDispatchContext);
  if (options.expectRequest === false) {
    // Iterate without swallowing: the rejection is the assertion.
    for await (const _event of stream) void _event;
    throw new Error("expected dispatch to reject, but it completed");
  }
  try {
    for await (const _event of stream) void _event;
  } catch {
    // A response body the stub cannot decode is not the assertion; the request
    // was already captured above and is what each case inspects.
  }
  expect(captured).toBeDefined();
  return captured!;
}

describe("factory-droid credential envelope", () => {
  const chatCandidate = target("chat", "/api/llm/o/v1/chat/completions");
  const secret = encodeFactoryDroidCredential({
    accessToken: "workos-access-token",
    orgId: "org_123",
  });

  test("sends the token as the bearer and the org claim as the upstream header", async () => {
    const captured = await post({ providerId: "factory-droid", secret, candidate: chatCandidate });
    expect(captured.headers["authorization"]).toBe("Bearer workos-access-token");
    expect(captured.headers["x-factory-org-id"]).toBe("org_123");
    expect(captured.headers["x-factory-client"]).toBe("cli");
  });

  test("never puts the envelope itself in the Authorization header", async () => {
    const captured = await post({ providerId: "factory-droid", secret, candidate: chatCandidate });
    expect(captured.headers["authorization"]).not.toContain("{");
  });

  test("posts chat traffic to the OpenAI wire prefix", async () => {
    const captured = await post({ providerId: "factory-droid", secret, candidate: chatCandidate });
    expect(captured.url).toBe("https://api.factory.ai/api/llm/o/v1/chat/completions");
  });

  test("posts messages traffic to the Anthropic wire prefix", async () => {
    const captured = await post({
      providerId: "factory-droid",
      secret,
      candidate: target("messages", "/api/llm/a/v1/messages"),
    });
    expect(captured.url).toBe("https://api.factory.ai/api/llm/a/v1/messages");
    expect(captured.headers["x-factory-org-id"]).toBe("org_123");
  });

  test("routes an EU account to the EU residency host", async () => {
    const captured = await post({
      providerId: "factory-droid",
      secret,
      candidate: chatCandidate,
      authState: { region: "eu" },
    });
    expect(captured.url).toBe("https://api.eu.factory.ai/api/llm/o/v1/chat/completions");
  });

  test("keeps a non-EU account on the global host", async () => {
    const captured = await post({
      providerId: "factory-droid",
      secret,
      candidate: chatCandidate,
      authState: { region: "us" },
    });
    expect(captured.url).toBe("https://api.factory.ai/api/llm/o/v1/chat/completions");
  });

  test("refuses a bare bearer that is not the envelope", async () => {
    // Without the org claim Factory rejects the call as an unscoped identity,
    // so the error has to name the credential, not the upstream.
    await expect(
      post({
        providerId: "factory-droid",
        secret: "workos-access-token",
        candidate: chatCandidate,
        expectRequest: false,
      }),
    ).rejects.toThrow(/not a JSON envelope/);
  });
});

describe("cloudflare-ai-gateway credential envelope", () => {
  const messagesCandidate = target("messages", "/v1/messages");
  const secret = encodeCloudflareAiGatewayCredential({
    token: "cf-gateway-token",
    accountId: "abc123",
    gatewayId: "my-gateway",
  });

  test("builds the base URL from the stored account and gateway slugs", async () => {
    const captured = await post({
      providerId: "cloudflare-ai-gateway",
      secret,
      candidate: messagesCandidate,
    });
    expect(captured.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/anthropic/v1/messages",
    );
  });

  test("authenticates with the gateway's own header, not Authorization", async () => {
    const captured = await post({
      providerId: "cloudflare-ai-gateway",
      secret,
      candidate: messagesCandidate,
    });
    expect(captured.headers["cf-aig-authorization"]).toBe("Bearer cf-gateway-token");
    // A bearer under a name the gateway ignores looks like a credential that
    // was tried and rejected, so it must not be sent at all.
    expect(captured.headers["authorization"]).toBeUndefined();
  });

  test("never puts the envelope itself in the auth header", async () => {
    const captured = await post({
      providerId: "cloudflare-ai-gateway",
      secret,
      candidate: messagesCandidate,
    });
    expect(captured.headers["cf-aig-authorization"]).not.toContain("{");
  });

  test("refuses a bare gateway token that is not the envelope", async () => {
    // The slugs are path segments: an envelope missing one would produce a URL
    // that resolves to some other account's gateway, or to none.
    await expect(
      post({
        providerId: "cloudflare-ai-gateway",
        secret: "cf-gateway-token",
        candidate: messagesCandidate,
        expectRequest: false,
      }),
    ).rejects.toThrow(/not a JSON envelope/);
  });
});

describe("alibaba-coding-plan credential envelope", () => {
  const chatCandidate = target("chat", "/chat/completions");

  test("sends an international key to the international host", async () => {
    const captured = await post({
      providerId: "alibaba-coding-plan",
      secret: encodeAlibabaCodingPlanCredential({ token: "sk-sp-intl", region: "international" }),
      candidate: chatCandidate,
    });
    expect(captured.url).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
  });

  test("sends a China key to the China host", async () => {
    const captured = await post({
      providerId: "alibaba-coding-plan",
      secret: encodeAlibabaCodingPlanCredential({ token: "sk-sp-cn", region: "china" }),
      candidate: chatCandidate,
    });
    expect(captured.url).toBe(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
  });

  test("does not double the version segment already in the base URL", async () => {
    const captured = await post({
      providerId: "alibaba-coding-plan",
      secret: encodeAlibabaCodingPlanCredential({ token: "sk-sp-intl", region: "international" }),
      candidate: chatCandidate,
    });
    expect(captured.url).not.toContain("/v1/v1/");
  });

  test("sends the token inside the envelope as the bearer", async () => {
    const captured = await post({
      providerId: "alibaba-coding-plan",
      secret: encodeAlibabaCodingPlanCredential({ token: "sk-sp-intl", region: "international" }),
      candidate: chatCandidate,
    });
    expect(captured.headers["authorization"]).toBe("Bearer sk-sp-intl");
  });

  test("refuses a stored region that is neither plan", async () => {
    // Dispatching to the other host would fail upstream with an error naming
    // neither plan; the operator needs to see the stored region.
    await expect(
      post({
        providerId: "alibaba-coding-plan",
        secret: encodeAlibabaCodingPlanCredential({ token: "sk-sp-x", region: "mars" }),
        candidate: chatCandidate,
        expectRequest: false,
      }),
    ).rejects.toThrow(/not a known plan/);
  });
});
