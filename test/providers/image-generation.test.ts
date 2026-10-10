import { describe, expect, test } from "bun:test";
import { createGeminiAdapter } from "../../src/providers/adapters/gemini";
import { createAntigravityAdapter } from "../../src/providers/integrations/antigravity/antigravity";
import { createCodexAdapter } from "../../src/providers/integrations/codex/codex";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
  ResolvedCredential,
  ValidatedOutboundFetch,
} from "../../src/providers/contracts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function context(
  providerId: ResolvedCredential["provider_id"],
  kind: ResolvedCredential["credential_kind"],
  fetcher: ValidatedOutboundFetch,
): ProviderDispatchContext {
  return {
    credential: {
      provider_id: providerId,
      credential_kind: kind,
      secret: new TextEncoder().encode(`${providerId}-test-secret`),
    },
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher,
  };
}

function target(
  providerId: ProviderDispatchTarget["provider_id"],
  modelId: string,
  endpoint: string,
): ProviderDispatchTarget {
  return {
    provider_id: providerId,
    model_id: modelId,
    wire_family: providerId === "codex" ? "responses" : "chat",
    endpoint_path: endpoint,
    capabilities: {},
  };
}

function capture(response: Response): {
  readonly fetcher: ValidatedOutboundFetch;
  readonly sent: () => {
    readonly url: string;
    readonly body: Record<string, unknown>;
    readonly headers: Record<string, string>;
  };
} {
  let url = "";
  let body: Record<string, unknown> = {};
  let headers: Record<string, string> = {};
  const fetcher: ValidatedOutboundFetch = async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    headers = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    return response.clone();
  };
  return { fetcher, sent: () => ({ url, body, headers }) };
}

describe("image generation request shape", () => {
  test("Gemini asks generateContent for IMAGE only and returns inline bytes", async () => {
    const captured = capture(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const adapter = createGeminiAdapter();
    if (adapter.generateImage === undefined) throw new Error("Gemini image adapter is missing");

    const outcome = await adapter.generateImage(
      { model: "gemini-2.5-flash-image", prompt: "a small red square" },
      target("gemini", "gemini-2.5-flash-image", "/v1beta/models"),
      context("gemini", "api_key", captured.fetcher),
    );

    const sent = captured.sent();
    expect(sent.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
    );
    expect(sent.body).toEqual({
      contents: [{ role: "user", parts: [{ text: "a small red square" }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    });
    expect(outcome.data).toEqual([{ b64_json: PNG, mime_type: "image/png" }]);
  });

  test("Gemini fails closed when the candidate has no inline image", async () => {
    const captured = capture(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "I cannot draw that" }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = createGeminiAdapter();
    if (adapter.generateImage === undefined) throw new Error("Gemini image adapter is missing");

    expect(
      adapter.generateImage(
        { prompt: "nothing" },
        target("gemini", "gemini-2.5-flash-image", "/v1beta/models"),
        context("gemini", "api_key", captured.fetcher),
      ),
    ).rejects.toMatchObject({ code: "platform_unavailable", status: 502 });
  });

  test("Antigravity streams the agent image envelope and reads inlineData from SSE", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    const fetcher: ValidatedOutboundFetch = async (input, init) => {
      url = String(input);
      const requested = String(input);
      if (!requested.includes("streamGenerateContent")) {
        return new Response(JSON.stringify({ cloudaicompanionProject: "project-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        [
          `data: ${JSON.stringify({
            response: {
              candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] } }],
            },
          })}`,
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const adapter = createAntigravityAdapter();
    if (adapter.generateImage === undefined) throw new Error("Antigravity image adapter is missing");

    const outcome = await adapter.generateImage(
      { model: "gemini-3.1-flash-image", prompt: "a small red square", size: "1792x1024", n: 1 },
      target("antigravity", "gemini-3.1-flash-image", "/v1internal:generateContent"),
      context("antigravity", "oauth", fetcher),
    );

    expect(url).toContain("/v1internal:streamGenerateContent?alt=sse");
    expect(body.requestType).toBe("agent");
    expect(body.model).toBe("gemini-3.1-flash-image");
    const request = body.request as Record<string, unknown>;
    const generation = request.generationConfig as Record<string, unknown>;
    expect(generation.responseModalities).toEqual(["IMAGE"]);
    expect(generation.imageConfig).toEqual({ aspectRatio: "16:9" });
    expect(request.contents).toEqual([{ role: "user", parts: [{ text: "a small red square" }] }]);
    expect(outcome.data).toEqual([{ b64_json: PNG, mime_type: "image/png" }]);
  });

  test("Codex sends the image tool through the gpt-5.5 carrier and reads the completed result", async () => {
    const captured = capture(
      new Response(
        [
          `data: ${JSON.stringify({
            type: "response.output_item.done",
            item: { type: "image_generation_call", result: PNG },
          })}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const adapter = createCodexAdapter({ provider_id: "codex", installation_id_override: "test-install" });
    if (adapter.generateImage === undefined) throw new Error("Codex image adapter is missing");

    const outcome = await adapter.generateImage(
      { model: "gpt-image-2.5", prompt: "a small red square", size: "1024x1024" },
      target("codex", "gpt-image-2.5", "/backend-api/codex/responses"),
      context("codex", "oauth", captured.fetcher),
    );
    const sent = captured.sent();
    expect(sent.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(sent.body.model).toBe("gpt-5.6-terra");
    expect(sent.body.stream).toBe(true);
    expect(sent.body.tool_choice).toEqual({ type: "image_generation" });
    expect(sent.body.client_metadata).toBeUndefined();
    expect(sent.headers["thread-id"]).toBeUndefined();
    expect(sent.headers["session_id"]).toBeTypeOf("string");
    expect(sent.headers["conversation_id"]).toBe(sent.headers["session_id"]);
    expect(sent.body.tools).toEqual([
      {
        type: "image_generation",
        action: "generate",
        output_format: "png",
        size: "1024x1024",
        model: "gpt-image-2.5",
      },
    ]);
    expect(outcome.data).toEqual([{ b64_json: PNG }]);
  });
});
