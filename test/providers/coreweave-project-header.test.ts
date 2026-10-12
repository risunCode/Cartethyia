/**
 * CoreWeave refuses every request that lacks `OpenAI-Project: <team>/<project>`.
 *
 * The header is the whole difference between a working account and a 401, and
 * the failure it causes is indistinguishable from a bad credential — which is
 * what makes it worth pinning. The requirement is also per-account: one
 * deployment may hold accounts on different teams, so the value cannot live in
 * a static `extra_headers` map where every account would share it.
 *
 * These drive the real dispatch path through the registered adapter with a
 * capturing fetch, because the failure being guarded is precisely "stored but
 * never sent" — a test that only checked persistence would pass while the
 * header never reached the wire.
 */
import { describe, expect, test } from "bun:test";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/contracts";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

const registry = createDefaultProviderRegistry();

const TARGET = {
  provider_id: "coreweave",
  model_id: "openai/gpt-oss-120b",
  wire_family: "chat",
  endpoint_path: "/chat/completions",
  capabilities: {},
} as unknown as ProviderDispatchTarget;

const REQUEST = {
  model: "openai/gpt-oss-120b",
  messages: [
    {
      role: "user",
      content: [{ kind: "text" as const, text: "hi" }],
    },
  ],
  generation_controls: {},
} as unknown as CanonicalRequest;

interface Captured {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function context(
  fetcher: typeof fetch,
  credential: ProviderDispatchContext["credential"],
): ProviderDispatchContext {
  return {
    credential,
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher as never,
  } as unknown as ProviderDispatchContext;
}

/** Captures each request's headers and answers an empty SSE stream. */
function capture(): { fetcher: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
    }
    calls.push({ url: String(url), headers });
    const body = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`;
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

async function dispatchHeader(
  credential: ProviderDispatchContext["credential"],
): Promise<string | undefined> {
  const adapter = await registry.resolve("coreweave");
  expect(adapter).toBeDefined();
  const { fetcher, calls } = capture();
  const stream = adapter!.dispatch(REQUEST, TARGET, context(fetcher, credential));
  // Draining the generator runs the transport, which is what sends the request.
  for await (const _event of stream) void _event;
  return calls[0]?.headers["openai-project"];
}

describe("coreweave OpenAI-Project header", () => {
  test("is sent from the account's auth_state", async () => {
    const header = await dispatchHeader({
      provider_id: "coreweave",
      credential_kind: "api_key",
      secret: new TextEncoder().encode("cw-secret"),
      auth_state: { coreweaveProject: "acme/prod" },
    });
    expect(header).toBe("acme/prod");
  });

  test("is sent from an account custom header when auth_state has none", async () => {
    // Both spellings exist because an account can be configured either way, and
    // reading only one would 401 the other with no local explanation.
    const header = await dispatchHeader({
      provider_id: "coreweave",
      credential_kind: "api_key",
      secret: new TextEncoder().encode("cw-secret"),
      custom_headers: { "OpenAI-Project": "acme/staging" },
    });
    expect(header).toBe("acme/staging");
  });

  test("is omitted, not empty, when the account has neither", async () => {
    // Deliberately not an error: the upstream answers 401 with a message
    // naming the header, which is more precise than anything asserted here.
    const header = await dispatchHeader({
      provider_id: "coreweave",
      credential_kind: "api_key",
      secret: new TextEncoder().encode("cw-secret"),
    });
    expect(header).toBeUndefined();
  });

  test("the bearer credential is still sent alongside it", async () => {
    // The header must not displace auth: this provider is a plain bearer
    // service that happens to also require a project header.
    const adapter = await registry.resolve("coreweave");
    const { fetcher, calls } = capture();
    const stream = adapter!.dispatch(
      REQUEST,
      TARGET,
      context(fetcher, {
        provider_id: "coreweave",
        credential_kind: "api_key",
        secret: new TextEncoder().encode("cw-secret"),
        auth_state: { coreweaveProject: "acme/prod" },
      }),
    );
    for await (const _event of stream) void _event;
    expect(calls[0]?.headers["authorization"]).toBe("Bearer cw-secret");
    expect(calls[0]?.url).toBe("https://api.inference.wandb.ai/v1/chat/completions");
  });
});