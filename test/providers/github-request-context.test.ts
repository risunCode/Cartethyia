import { describe, expect, test } from "bun:test";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/contracts";
import { githubAdapter } from "../../src/providers/integrations/github/github";
import { defineModel } from "../../src/providers/model-definition";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

const candidate = {
  provider_id: "github",
  model_id: "gpt-4.1",
  wire_family: "chat",
  endpoint_path: "/chat/completions",
  capabilities: {},
} as unknown as ProviderDispatchTarget;

const baseRequest = {
  model: "gpt-4.1",
  messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
  generation_controls: {},
  stream: false,
} as unknown as CanonicalRequest;

interface CapturedRequest {
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

async function capture(request: CanonicalRequest, credential = "account-a"): Promise<CapturedRequest> {
  let captured: CapturedRequest | undefined;
  const outboundFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = {
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } });
  }) as unknown as ProviderDispatchContext["outbound_fetch"];
  const stream = githubAdapter.dispatch(request, candidate, {
    credential: {
      provider_id: "github",
      credential_kind: "oauth",
      secret: new TextEncoder().encode(JSON.stringify({
        access: "copilot-access",
        apiHost: "copilot.example",
        github: credential,
      })),
    },
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: outboundFetch,
    request_id: "gateway-request-123",
  } as unknown as ProviderDispatchContext);
  try {
    for await (const _event of stream) void _event;
  } catch {
    // The captured outbound request is the assertion; response decoding is irrelevant here.
  }
  expect(captured).toBeDefined();
  return captured!;
}

describe("GitHub Copilot request context", () => {
  test("adds initiator, image, and stable correlation headers only to inference requests", async () => {
    const userRequest = await capture(baseRequest);
    expect(userRequest.headers.get("x-initiator")).toBe("user");
    expect(userRequest.headers.get("copilot-vision-request")).toBeNull();
    expect(userRequest.headers.get("x-request-id")).toBe("gateway-request-123");
    expect(userRequest.headers.get("x-agent-task-id")).toBe("gateway-request-123");
    expect(userRequest.headers.get("openai-intent")).toBe("conversation-agent");
    expect(userRequest.headers.get("x-interaction-type")).toBe("conversation-agent");

    const agentRequest = await capture({
      ...baseRequest,
      messages: [{ role: "assistant", content: [{ kind: "text", text: "continuing" }] }],
    } as unknown as CanonicalRequest);
    expect(agentRequest.headers.get("x-initiator")).toBe("agent");

    const toolResultRequest = await capture({
      ...baseRequest,
      messages: [{
        role: "user",
        content: [{
          kind: "toolResult",
          call_id: "call-1",
          content: [{ kind: "image", payload: { data: "tool-image" } }],
        }],
      }],
    } as unknown as CanonicalRequest);
    expect(toolResultRequest.headers.get("x-initiator")).toBe("agent");
    expect(toolResultRequest.headers.get("copilot-vision-request")).toBe("true");

    const imageRequest = await capture({
      ...baseRequest,
      messages: [{
        role: "user",
        content: [{ kind: "image", payload: { data: "image-data" } }],
      }],
    } as unknown as CanonicalRequest);
    expect(imageRequest.headers.get("copilot-vision-request")).toBe("true");
  });

  test("adds long-context tier only for the account whose catalog discovered it", async () => {
    const { recordGithubLongContextModels } = await import(
      "../../src/providers/integrations/github/github"
    );
    const longModel = defineModel({
      id: "gpt-4.1",
      providerId: "github",
      ctx: 600_000,
    });
    recordGithubLongContextModels(
      JSON.stringify({ access: "a", apiHost: "copilot.example", github: "account-a" }),
      [longModel],
    );

    const firstAccount = await capture(baseRequest, "account-a");
    const secondAccount = await capture(baseRequest, "account-b");
    expect(firstAccount.body.contextTier).toBe("long_context");
    expect(secondAccount.body.contextTier).toBeUndefined();
  });
});
