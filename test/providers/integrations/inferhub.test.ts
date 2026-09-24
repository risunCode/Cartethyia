import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";
import type { ProviderDispatchTarget, ProviderDispatchContext } from "../../../src/providers/provider-registry";
import {
  INFERHUB_MODELS,
  createInferhubAdapter,
  ensureInferhubMessagesTextBreakpoints,
  isInferhubClaudeModel,
} from "../../../src/providers/integrations/inferhub";

function request(model = "ag/claude-opus-4-6-thinking"): CanonicalRequest {
  return {
    model,
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  };
}

function candidate(wireFamily: ProviderDispatchTarget["wire_family"], modelId: string): ProviderDispatchTarget {
  return {
    provider_id: "inferhub",
    model_id: modelId,
    wire_family: wireFamily,
    endpoint_path: wireFamily === "messages" ? "/v1/messages" : "/chat/completions",
    capabilities: {},
  };
}

function context(): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "inferhub",
      credential_kind: "api_key",
      secret: new TextEncoder().encode("test-key"),
    },
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
  };
}

describe("isInferhubClaudeModel", () => {
  test("matches Claude-backed ids across prefixes", () => {
    expect(isInferhubClaudeModel("ag/claude-opus-4-6-thinking")).toBe(true);
    expect(isInferhubClaudeModel("cb/claude-opus-4.6")).toBe(true);
    expect(isInferhubClaudeModel("cc/claude-sonnet-4-6")).toBe(true);
    expect(isInferhubClaudeModel("ag/gemini-3.7-flash-high")).toBe(false);
    expect(isInferhubClaudeModel("ali/qwen3.8-max")).toBe(false);
  });
});

describe("INFERHUB_MODELS wire families", () => {
  test("Claude-backed models resolve to messages, rest stay on chat", () => {
    const byId = new Map(INFERHUB_MODELS.map((m) => [m.modelId, m]));
    expect(byId.get("ag/claude-sonnet-4-6")?.wireFamily).toBe("messages");
    expect(byId.get("ag/claude-sonnet-4-6")?.endpointPath).toBe("/messages");
    expect(byId.get("cb/claude-opus-4.6")?.wireFamily).toBe("messages");
    expect(byId.get("cc/claude-sonnet-4-6")?.wireFamily).toBe("messages");
    expect(byId.get("ali/qwen3.8-max")?.wireFamily).toBe("chat");
  });

  test("GPT-5/6 rows resolve to responses", () => {
    const byId = new Map(INFERHUB_MODELS.map((m) => [m.modelId, m]));
    expect(byId.get("cx/gpt-5.6-terra")?.wireFamily).toBe("responses");
    expect(byId.get("cx/gpt-5.6-terra")?.endpointPath).toBe("/responses");
    expect(byId.get("cb/gpt-5.6-sol")?.wireFamily).toBe("responses");
  });

  /**
   * `cb/deepseek-v4.1-flash` is neither Claude-backed (not `messages`) nor a
   * GPT-5/6 id (not `responses`), so it must land on the plain chat wire. Its
   * limits are the ones CodeBuddy's own catalog declares for this model, and
   * they surface as `context_length` / `max_output_tokens` on `/v1/models`, so
   * a silent change here is visible to clients.
   */
  test("cb/deepseek-v4.1-flash serves chat with CodeBuddy's declared limits", () => {
    const model = INFERHUB_MODELS.find((m) => m.modelId === "cb/deepseek-v4.1-flash");
    expect(model).toBeDefined();
    expect(model!.wireFamily).toBe("chat");
    expect(model!.endpointPath).toBe("/chat/completions");
    expect(model!.contextLimit).toBe(1_000_000);
    expect(model!.outputLimit).toBe(384_000);
    // Vision arrives as a modality, not a `vision` flag on the definition.
    expect(model!.modalities.input).toContain("image");
    expect(model!.reasoning).toBe(true);
    expect(model!.toolCall).toBe(true);
  });

  test("every model id in the catalog is unique", () => {
    // Two rows sharing an id would silently shadow each other in the flat map
    // the tests above use, so a duplicate would make one assertion meaningless.
    const ids = INFERHUB_MODELS.map((m) => m.modelId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("inferhub wire branching", () => {
  test("messages candidate hits /v1/messages with Bearer auth and Claude payload", async () => {
    let url = "";
    let headers = new Headers();
    let body: Record<string, unknown> = {};
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const adapter = createInferhubAdapter(fetcher);
    const events: string[] = [];
    for await (const event of adapter.dispatch(
      request(),
      candidate("messages", "ag/claude-opus-4-6-thinking"),
      context(),
    )) {
      events.push(event.type);
    }

    expect(url).toContain("/v1/messages");
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(body["model"]).toBe("ag/claude-opus-4-6-thinking");
    // No client opt-in: the adapter defaults to a stable-prefix breakpoint.
    expect(JSON.stringify(body)).toContain("cache_control");
    expect(events).toContain("content_delta");
    expect(events).toContain("terminal");
  });

  test("chat candidate stays on the OpenAI-compatible wire", async () => {
    let url = "";
    const fetcher = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      url = String(input);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const adapter = createInferhubAdapter(fetcher);
    for await (const _event of adapter.dispatch(
      request("ag/gemini-3.7-flash-high"),
      candidate("chat", "ag/gemini-3.7-flash-high"),
      context(),
    )) {}

    expect(url).toContain("/chat/completions");
  });
});

describe("ensureInferhubMessagesTextBreakpoints", () => {
  test("stamps first text when the last message is tool_result", () => {
    const payload = ensureInferhubMessagesTextBreakpoints({
      model: "ag/claude-opus-4-6-thinking",
      stream: true,
      system: [{ type: "text", text: "stable system", cache_control: { type: "ephemeral" } }],
      tools: [
        {
          name: "bash",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "do the thing" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "ls" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
      ],
    });

    const messages = payload["messages"] as Array<Record<string, unknown>>;
    const first = (messages[0]?.["content"] as Array<Record<string, unknown>>)[0];
    const last = messages[messages.length - 1]?.["content"] as Array<Record<string, unknown>>;
    expect(first?.["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(last.some((block) => block["type"] === "text" && block["cache_control"] !== undefined)).toBe(
      false,
    );
  });

  test("appends a text marker when the transcript has no text blocks", () => {
    const payload = ensureInferhubMessagesTextBreakpoints({
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
      ],
    });
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    const content = messages[0]?.["content"] as Array<Record<string, unknown>>;
    expect(content.at(-1)).toEqual({
      type: "text",
      text: " ",
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  });
});

describe("inferhub streaming text breakpoints", () => {
  test("messages dispatch stamps text even when the last turn is tool_result", async () => {
    let body: Record<string, unknown> = {};
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const adapter = createInferhubAdapter(fetcher);
    const req: CanonicalRequest = {
      ...request(),
      stream: false,
      system: [{ kind: "text", text: "stable system prompt that is long enough" }],
      tools: [{ name: "bash", jsonSchema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ kind: "text", text: "do the thing" }] },
        {
          role: "assistant",
          content: [
            {
              kind: "toolCall",
              call_id: "toolu_1",
              name: "bash",
              arguments: { command: "ls" },
            },
          ],
        },
        {
          role: "user",
          content: [{ kind: "toolResult", call_id: "toolu_1", content: "ok" }],
        },
      ],
    };
    for await (const _event of adapter.dispatch(
      req,
      candidate("messages", "ag/claude-opus-4-6-thinking"),
      context(),
    )) {}

    const messages = body["messages"] as Array<Record<string, unknown>>;
    const firstContent = messages[0]?.["content"] as Array<Record<string, unknown>>;
    expect(firstContent[0]?.["type"]).toBe("text");
    expect(firstContent[0]?.["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});
