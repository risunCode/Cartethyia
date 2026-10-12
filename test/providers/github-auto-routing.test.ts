import { describe, expect, test } from "bun:test";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/contracts";
import {
  GITHUB_AUTO_MODEL_TIERS,
  githubAdapter,
} from "../../src/providers/integrations/github/github";
import type { CanonicalEvent, CanonicalRequest } from "../../src/protocol/canonical-model";
import { applyParamQuirks } from "../../src/transport/translation/quirks";
import { chatAdapter } from "../../src/transport/surface/chat/adapter";

const credential = JSON.stringify({
  access: "copilot-access",
  apiHost: "copilot.example",
  github: "account-auto",
});

const request = {
  model: "auto-intelligence",
  messages: [{ role: "user", content: [{ kind: "text", text: "Find the bug." }] }],
  generation_controls: { temperature: 0.2 },
  source_surface: "chat",
  stream: false,
} as unknown as CanonicalRequest;

const candidate: ProviderDispatchTarget = {
  provider_id: "github",
  model_id: "auto-intelligence",
  wire_family: "chat",
  endpoint_path: "/chat/completions",
  capabilities: {},
};

describe("GitHub Copilot Auto routing", () => {
  test("maps catalog variants to supported Auto tiers", () => {
    expect(GITHUB_AUTO_MODEL_TIERS.get("auto")).toBe("balance");
    expect(GITHUB_AUTO_MODEL_TIERS.get("auto-efficiency")).toBe("efficiency");
    expect(GITHUB_AUTO_MODEL_TIERS.get("auto-balance")).toBe("balance");
    expect(GITHUB_AUTO_MODEL_TIERS.get("auto-intelligence")).toBe("intelligence");
  });

  test("applies GitHub sampling quirks before wire serialization", () => {
    const requestWithSampling = {
      ...request,
      generation_controls: { temperature: 0.2, top_p: 0.8, max_tokens: 128 },
    } as CanonicalRequest;
    const prepared = applyParamQuirks(requestWithSampling, "github");

    expect(prepared.generation_controls.temperature).toBeUndefined();
    expect(prepared.generation_controls.top_p).toBe(0.8);
    expect(prepared.generation_controls.max_tokens).toBe(128);
    expect(requestWithSampling.generation_controls.temperature).toBe(0.2);
  });

  test("reuses the Auto model and session token across tool turns", async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const outboundFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ url, headers: new Headers(init?.headers), body });
      if (url.endsWith("/auto")) {
        return new Response(JSON.stringify({
          selected_model: { id: "routed-model" },
          session_token: "auto-session-token",
          expires_at: Math.floor(Date.now() / 1_000) + 3_600,
        }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [{ id: "routed-model", supported_endpoints: ["/responses"] }],
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "response-1",
        object: "response",
        status: "completed",
        output: [
          {
            id: "reasoning-1",
            type: "reasoning",
            encrypted_content: "opaque-reasoning-artifact",
            summary: [{ type: "summary_text", text: "I will inspect the relevant file." }],
            content: [{ type: "reasoning_text", text: "raw private reasoning" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "fixed", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { headers: { "content-type": "application/json" } });
    }) as unknown as ProviderDispatchContext["outbound_fetch"];

    const context = {
      credential: {
        provider_id: "github",
        credential_kind: "oauth",
        secret: new TextEncoder().encode(credential),
      },
      deadline: Date.now() + 30_000,
      abort_signal: new AbortController().signal,
      outbound_fetch: outboundFetch,
      request_headers: { "x-session-id": "auto-session-1" },
    } as unknown as ProviderDispatchContext;
    const firstRequest = {
      ...request,
      messages: [
        { role: "user", content: [{ kind: "text", text: "An earlier question." }] },
        { role: "assistant", content: [{ kind: "text", text: "An earlier answer." }] },
        request.messages[0],
      ],
    } as unknown as CanonicalRequest;
    const firstTurnEvents: CanonicalEvent[] = [];
    for await (const event of githubAdapter.dispatch(
      firstRequest,
      candidate,
      { ...context, request_id: "auto-request-1" },
    )) firstTurnEvents.push(event);

    const followupRequest = {
      ...firstRequest,
      messages: [
        ...firstRequest.messages,
        {
          role: "assistant",
          content: [
            { kind: "reasoning", payload: "I should inspect the source." },
            {
              kind: "toolCall",
              call_id: "call-read-file",
              name: "read_file",
              arguments: JSON.stringify({ path: "src/index.ts" }),
            },
          ],
        },
        {
          role: "tool",
          content: [{
            kind: "toolResult",
            call_id: "call-read-file",
            content: "The route is declared here.",
          }],
        },
      ],
      tools: [{
        name: "read_file",
        description: "Read a source file",
        jsonSchema: { type: "object", properties: { path: { type: "string" } } },
      }],
    } as unknown as CanonicalRequest;
    const followupEvents: CanonicalEvent[] = [];
    for await (const event of githubAdapter.dispatch(
      followupRequest,
      candidate,
      { ...context, request_id: "auto-request-2" },
    )) followupEvents.push(event);

    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/auto",
      "/models",
      "/responses",
      "/responses",
    ]);
    expect(requests[0]?.body).toEqual({
      prompt: "Find the bug.",
      tier: "intelligence",
    });
    expect(requests[0]?.headers.get("x-github-api-version")).toBe("2026-08-01");
    expect(requests[2]?.body.model).toBe("routed-model");
    expect(requests[2]?.body.temperature).toBeUndefined();
    expect(requests[2]?.body.reasoning).toEqual({ summary: "detailed" });
    expect(requests[0]?.body.multi_turn).toBeUndefined();
    expect(requests[0]?.headers.get("copilot-session-token")).toBeNull();
    expect(requests[2]?.headers.get("copilot-session-token")).toBe("auto-session-token");
    expect(requests[3]?.headers.get("copilot-session-token")).toBe("auto-session-token");
    const followupInput = requests[3]?.body.input as Array<Record<string, unknown>>;
    expect(followupInput.some((item) => item.type === "function_call")).toBe(true);
    expect(followupInput.some((item) => item.type === "function_call_output")).toBe(true);
    expect(followupInput.some((item) => item.type === "reasoning")).toBe(true);
    const clientResponse = JSON.parse(
      new TextDecoder().decode(chatAdapter.encode(firstTurnEvents).bytes),
    ) as {
      choices: Array<{ message: { reasoning_content?: string } }>;
    };
    expect(clientResponse.choices[0]?.message.reasoning_content)
      .toBe("I will inspect the relevant file. raw private reasoning");
    expect(JSON.stringify(clientResponse)).not.toContain("opaque-reasoning-artifact");
    expect(JSON.stringify(clientResponse)).toContain("raw private reasoning");
  });
});
