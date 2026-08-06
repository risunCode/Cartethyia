import { describe, expect, test } from "bun:test";
import type {
  NetworkSelection,
  NormalizedProviderRequest,
  ProviderOutput,
  ProviderRequest,
  StreamEvent,
} from "../../src/domain/contracts";
import { AnthropicOAuthAdapter } from "../../src/providers/claude-code";
import {
  CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  claudeBillingHeaderPrefix,
  claudeCchPlaceholder,
  claudeAgentSdkVersion,
  claudeCodeSystemInstruction,
  claudeCodeVersion,
  claudeToolPrefix,
} from "../../src/providers/claude-code-fingerprint";
import { ProviderAdapterError, isRecord } from "../../src/providers/shared";

const limits = {
  maxBodyBytes: 2 * 1024 * 1024,
  connectTimeoutMs: 100,
  firstByteTimeoutMs: 100,
  idleTimeoutMs: 100,
  totalTimeoutMs: 1_000,
} as const;

function request(overrides: Partial<NormalizedProviderRequest> = {}): NormalizedProviderRequest {
  return {
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello world" }] }],
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "anthropic-messages",
    signal: new AbortController().signal,
    limits,
    ...overrides,
  };
}

const emptyNetwork: NetworkSelection = { proxyId: null, url: null, release: async () => {} };

function providerRequest(
  adapter: { metadata: { id: string } },
  modelId: string,
  surface: "anthropic-messages" | "openai-chat" = "anthropic-messages",
  credential = "oauth-token-123",
  requestOverrides: Partial<NormalizedProviderRequest> = {},
): ProviderRequest {
  return {
    target: { providerId: adapter.metadata.id, modelId, surface },
    request: request({ model: modelId, ...requestOverrides }),
    credential,
    network: emptyNetwork,
    signal: new AbortController().signal,
  };
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubFetchFor(capture: CapturedCall, json: Record<string, unknown>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init ?? {};
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Parses the captured request body into a typed record. */
function bodyOf(capture: CapturedCall): Record<string, unknown> {
  return JSON.parse(capture.init.body as string) as Record<string, unknown>;
}

/** Reads a `system` array block's `.text` field at the given index, or null. */
function systemText(body: Record<string, unknown>, index: number): string | null {
  if (!Array.isArray(body.system)) return null;
  const block = body.system[index];
  if (isRecord(block) && typeof block.text === "string") return block.text;
  return null;
}

/** Collects all `text` values from `system` blocks for membership checks. */
function systemTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.system)) return [];
  return body.system.filter(isRecord).map((b) => (typeof b.text === "string" ? b.text : "")).filter((t) => t.length > 0);
}

/** Reads the billing-header block (first system entry starting with the prefix). */
function billingHeader(body: Record<string, unknown>): string | null {
  for (const text of systemTexts(body)) {
    if (text.startsWith(claudeBillingHeaderPrefix)) return text;
  }
  return null;
}

/** Extracts the 5-char cch hex value from a billing header string, or null. */
function cchHashOf(billing: string): string | null {
  const match = billing.match(/cch=([0-9a-f]{5})/);
  const group = match?.[1];
  return typeof group === "string" ? group : null;
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function anthropicFrame(json: Record<string, unknown>): string {
  return `event: ${json.type}\ndata: ${JSON.stringify(json)}\n\n`;
}

async function collectEvents(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const collected: StreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

/** Narrows a ProviderOutput to its stream variant and returns the events. */
function streamEventsOf(output: ProviderOutput): AsyncIterable<StreamEvent> {
  if (output.mode !== "stream") throw new Error("expected stream output");
  return output.events;
}

/** Narrows a StreamEvent to text_delta and returns its text (empty if not found). */
function textDeltaText(event: StreamEvent): string {
  return event.type === "text_delta" ? event.text : "";
}

const adapter = new AnthropicOAuthAdapter();

describe("isClaudeMetadataUserId — Claude metadata user ID pattern", () => {
  test("accepts the canonical user_account_session composite", async () => {
    const canonical =
      "user_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_account_11111111-2222-3333-4444-555555555555_session_66666666-7777-8888-9999-aaaaaaaaaaaa";
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg_1", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5"),
        request: request({ model: "claude-sonnet-5", metadataUserId: canonical }),
      });
      expect(bodyOf(capture).metadata).toEqual({ user_id: canonical });
    } finally {
      restore();
    }
  });

  test("accepts a JSON form with a session_id string field", async () => {
    const jsonForm = JSON.stringify({ session_id: "sess-abc-123" });
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg_2", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5"),
        request: request({ model: "claude-sonnet-5", metadataUserId: jsonForm }),
      });
      expect(bodyOf(capture).metadata).toEqual({ user_id: jsonForm });
    } finally {
      restore();
    }
  });

  test("rejects a plain non-matching string by stripping metadata", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg_3", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5"),
        request: request({ model: "claude-sonnet-5", metadataUserId: "not-a-valid-user-id" }),
      });
      expect(bodyOf(capture).metadata).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("rejects JSON form without a session_id field", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg_4", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5"),
        request: request({ model: "claude-sonnet-5", metadataUserId: JSON.stringify({ other: "value" }) }),
      });
      expect(bodyOf(capture).metadata).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe("attestClaudePayload — cch placeholder attestation", () => {
  test("replaces the cch placeholder with a computed 5-char hex hash", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg_5", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call(providerRequest(adapter, "claude-sonnet-5"));
      const bodyText = capture.init.body as string;
      expect(bodyText).not.toContain(claudeCchPlaceholder);
      const billing = billingHeader(bodyOf(capture));
      expect(billing).not.toBeNull();
      const cch = cchHashOf(billing!);
      expect(cch).not.toBeNull();
      expect(cch!.length).toBe(5);
    } finally {
      restore();
    }
  });

  test("is deterministic — same user text yields the same cch hash", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "m", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    let firstCch: string;
    try {
      await adapter.call(providerRequest(adapter, "claude-sonnet-5"));
      firstCch = cchHashOf(billingHeader(bodyOf(capture))!)!;
    } finally {
      restore();
    }
    const capture2: CapturedCall = { url: "", init: {} };
    const restore2 = stubFetchFor(capture2, { id: "m", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call(providerRequest(adapter, "claude-sonnet-5"));
      const secondCch = cchHashOf(billingHeader(bodyOf(capture2))!)!;
      expect(secondCch).toBe(firstCch);
    } finally {
      restore2();
    }
  });
});

describe("applyClaudeCodeCompatibility — edge cases", () => {
  test("caps max_tokens at the Claude Code limit", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call({
        ...providerRequest(adapter, "claude-opus-5"),
        request: request({ model: "claude-opus-5", maxOutputTokens: 500_000 }),
      });
      expect(bodyOf(capture).max_tokens).toBe(CLAUDE_CODE_MAX_OUTPUT_TOKENS);
    } finally {
      restore();
    }
  });

  test("injects billing header and system instruction into an array system", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5"),
        request: request({
          model: "claude-sonnet-5",
          messages: [
            { role: "system", content: [{ type: "text", text: "You are helpful." }] },
            { role: "user", content: [{ type: "text", text: "Hi" }] },
          ],
        }),
      });
      const body = bodyOf(capture);
      expect(systemText(body, 0)).toContain(claudeBillingHeaderPrefix);
      expect(systemTexts(body)).toContain(claudeCodeSystemInstruction);
      expect(systemTexts(body)).toContain("You are helpful.");
    } finally {
      restore();
    }
  });

  test("injects billing + instruction when system is a non-empty string", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5"),
        request: request({
          model: "claude-sonnet-5",
          messages: [
            { role: "system", content: [{ type: "text", text: "Be concise." }] },
            { role: "user", content: [{ type: "text", text: "Go" }] },
          ],
        }),
      });
      const body = bodyOf(capture);
      expect(systemText(body, 0)).toContain(claudeBillingHeaderPrefix);
      expect(systemText(body, 1)).toBe(claudeCodeSystemInstruction);
      expect(systemText(body, 2)).toBe("Be concise.");
    } finally {
      restore();
    }
  });

  test("wraps a string system with billing + instruction even when the text already starts with the prefix", async () => {
    // applyClaudeCodeCompatibility only deduplicates against an ARRAY
    // system (hasBilling check). A string system is always wrapped with a
    // fresh billing + instruction prefix, so the original text is preserved
    // as the third block. This verifies the string-system cutover path.
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5"),
        request: request({
          model: "claude-sonnet-5",
          messages: [
            { role: "system", content: [{ type: "text", text: `${claudeBillingHeaderPrefix} existing-billing;` }] },
            { role: "user", content: [{ type: "text", text: "Go" }] },
          ],
        }),
      });
      const texts = systemTexts(bodyOf(capture));
      expect(texts[0]?.startsWith(claudeBillingHeaderPrefix)).toBe(true);
      expect(texts[0]).not.toContain("cch=00000");
      expect(texts[1]).toBe(claudeCodeSystemInstruction);
      expect(texts[2]).toBe(`${claudeBillingHeaderPrefix} existing-billing;`);
    } finally {
      restore();
    }
  });

  test("prefixes custom tool names with the Claude underscore, preserves builtins", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5"),
        request: request({
          model: "claude-sonnet-5",
          tools: [
            { name: "bash", description: "run", inputSchema: { type: "object" } },
            { name: "web_search", description: "search", inputSchema: { type: "object" } },
            { name: "code_execution", description: "exec", inputSchema: { type: "object" } },
          ],
        }),
      });
      const tools = bodyOf(capture).tools;
      expect(Array.isArray(tools)).toBe(true);
      const names = (tools as Array<Record<string, unknown>>).filter(isRecord).map((t) => (typeof t.name === "string" ? t.name : ""));
      expect(names).toContain(`${claudeToolPrefix}bash`);
      expect(names).toContain("web_search");
      expect(names).toContain("code_execution");
    } finally {
      restore();
    }
  });

  test("strips the underscore prefix from streamed tool call names", async () => {
    const frames = [
      anthropicFrame({ type: "message_start", message: { id: "msg_s1", usage: { input_tokens: 5 } } }),
      anthropicFrame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: `${claudeToolPrefix}bash` } }),
      anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"cmd":"ls"' } }),
      anthropicFrame({ type: "content_block_stop", index: 0 }),
      anthropicFrame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }),
      anthropicFrame({ type: "message_stop" }),
    ];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => sseResponse(frames)) as typeof fetch;
    try {
      const output = await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5"),
        request: request({ model: "claude-sonnet-5", stream: true }),
      });
      expect(output.mode).toBe("stream");
      const events = await collectEvents(streamEventsOf(output));
      const start = events.find((e) => e.type === "tool_call_start");
      expect(start).toBeDefined();
      const toolName = start?.type === "tool_call_start" ? start.name : "";
      expect(toolName).toBe("bash");
      expect(events.some((e) => e.type === "tool_call_delta")).toBe(true);
      expect(events.some((e) => e.type === "tool_call_end")).toBe(true);
      expect(events[events.length - 1]?.type).toBe("message_stop");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("createClaudeBillingHeader — billing header construction", () => {
  test("includes the version and entrypoint label", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call(providerRequest(adapter, "claude-sonnet-5"));
      const billing = billingHeader(bodyOf(capture));
      expect(billing).toContain("cc_entrypoint=local-agent");
      expect(billing).toContain("cc_version=");
    } finally {
      restore();
    }
  });

  test("derives the hash suffix from the first user message text", async () => {
    const c1: CapturedCall = { url: "", init: {} };
    const r1 = stubFetchFor(c1, { id: "m", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    let billing1: string;
    try {
      await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5"),
        request: request({ model: "claude-sonnet-5", messages: [{ role: "user", content: [{ type: "text", text: "Apple pie" }] }] }),
      });
      billing1 = billingHeader(bodyOf(c1))!;
    } finally {
      r1();
    }
    const c2: CapturedCall = { url: "", init: {} };
    const r2 = stubFetchFor(c2, { id: "m", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    let billing2: string;
    try {
      await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5"),
        request: request({ model: "claude-sonnet-5", messages: [{ role: "user", content: [{ type: "text", text: "Banana bread" }] }] }),
      });
      billing2 = billingHeader(bodyOf(c2))!;
    } finally {
      r2();
    }
    expect(billing1).not.toBe(billing2);
  });
});

describe("resolveTarget — surface and model validation", () => {
  test("resolves a known model on the supported anthropic-messages surface", () => {
    expect(adapter.resolveTarget("claude-opus-5", "anthropic-messages")).toEqual({
      providerId: "claude",
      modelId: "claude-opus-5",
      surface: "anthropic-messages",
    });
  });

  test("resolves all catalogued models", () => {
    for (const modelId of ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]) {
      expect(adapter.resolveTarget(modelId, "anthropic-messages").modelId).toBe(modelId);
    }
  });

  test("rejects an unsupported surface with capability_unsupported", () => {
    expect(() => adapter.resolveTarget("claude-sonnet-5", "openai-chat")).toThrow(ProviderAdapterError);
    expect(() => adapter.resolveTarget("claude-sonnet-5", "openai-chat")).toThrow(/does not support surface/);
  });

  test("rejects an unknown model with model_not_found", () => {
    expect(() => adapter.resolveTarget("not-a-claude-model", "anthropic-messages")).toThrow(ProviderAdapterError);
    expect(() => adapter.resolveTarget("not-a-claude-model", "anthropic-messages")).toThrow(/not in the/);
  });
});

describe("AnthropicOAuthAdapter.call — streaming preserves reasoning and tool calls", () => {
  test("maps thinking deltas, text deltas, and usage in a full stream", async () => {
    const frames = [
      anthropicFrame({ type: "message_start", message: { id: "msg_s2", usage: { input_tokens: 10, cache_creation_input_tokens: 2 } } }),
      anthropicFrame({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think" } }),
      anthropicFrame({ type: "content_block_stop", index: 0 }),
      anthropicFrame({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      anthropicFrame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } }),
      anthropicFrame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " world" } }),
      anthropicFrame({ type: "content_block_stop", index: 1 }),
      anthropicFrame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
      anthropicFrame({ type: "message_stop" }),
    ];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => sseResponse(frames)) as typeof fetch;
    try {
      const output = await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5"),
        request: request({ model: "claude-sonnet-5", stream: true }),
      });
      expect(output.mode).toBe("stream");
      const events = await collectEvents(streamEventsOf(output));
      const types = events.map((e) => e.type);
      expect(types[0]).toBe("message_start");
      expect(types).toContain("thinking_delta");
      const text = events.filter((e) => e.type === "text_delta").map(textDeltaText).join("");
      expect(text).toBe("Hello world");
      const usage = events.find((e) => e.type === "usage");
      expect(usage).toBeDefined();
      if (usage?.type === "usage") {
        expect(usage.usage.inputTokens).toBe(10);
      }
      expect(events[events.length - 1]?.type).toBe("message_stop");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("AnthropicOAuthAdapter.call — credential guard", () => {
  test("rejects an empty credential before any fetch", async () => {
    let fetchCalled = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        adapter.call({
          ...providerRequest(adapter, "claude-sonnet-5", "anthropic-messages", ""),
          request: request({ model: "claude-sonnet-5" }),
        }),
      ).rejects.toThrow(/OAuth credential is required/i);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("rejects a wrong-surface target before any fetch", async () => {
    let fetchCalled = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        adapter.call({
          ...providerRequest(adapter, "claude-sonnet-5", "anthropic-messages", "token"),
          target: { providerId: "claude", modelId: "claude-sonnet-5", surface: "openai-chat" },
        }),
      ).rejects.toThrow(ProviderAdapterError);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("AnthropicOAuthAdapter.call — non-stream request shape", () => {
  test("posts to the Anthropic messages endpoint with OAuth bearer and beta headers", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg_x", type: "message", role: "assistant", content: [], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } });
    try {
      const output = await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5", "anthropic-messages", "my-oauth-token"),
        request: request({ model: "claude-sonnet-5" }),
      });
      expect(output.mode).toBe("non_stream");
      expect(capture.url).toBe("https://api.anthropic.com/v1/messages");
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer my-oauth-token");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
      expect(headers["x-app"]).toBe("cli");
      expect(headers.accept).toBe("application/json");
      expect(headers["anthropic-beta"]).toContain("claude-code-20250219");
      expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
      expect(output.usage).toMatchObject({ inputTokens: 3, outputTokens: 1, source: "provider" });
    } finally {
      restore();
    }
  });

  test("forwards a claude-cli User-Agent and emits the fingerprint when absent", async () => {
    const capture1: CapturedCall = { url: "", init: {} };
    const restore1 = stubFetchFor(capture1, { id: "m", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5"),
        headers: new Headers({ "user-agent": "claude-cli/2.1.0" }),
      });
      const headers1 = capture1.init.headers as Record<string, string>;
      expect(headers1["user-agent"]).toBe("claude-cli/2.1.0");
    } finally {
      restore1();
    }
    const capture2: CapturedCall = { url: "", init: {} };
    const restore2 = stubFetchFor(capture2, { id: "m", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      await adapter.call({
        ...providerRequest(adapter, "claude-sonnet-5"),
        headers: new Headers({ "user-agent": "curl/8" }),
      });
      const headers2 = capture2.init.headers as Record<string, string>;
      // The adapter proxies as claude-code, so it emits the canonical
      // claude-cli fingerprint when the client did not supply one.
      expect(headers2["user-agent"]).toBe(`claude-cli/${claudeCodeVersion} (external, local-agent, agent-sdk/${claudeAgentSdkVersion})`);
    } finally {
      restore2();
    }
  });
});

describe("AnthropicOAuthAdapter — metadata and catalog", () => {
  test("exposes the Claude Code identity and capabilities", () => {
    expect(adapter.metadata).toMatchObject({ id: "claude", displayName: "Claude Code", protocol: "anthropic", credentialKind: "oauth" });
    expect(adapter.capabilities.streaming).toBe(true);
    expect(adapter.capabilities.surfaces).toContain("anthropic-messages");
  });

  test("exposes the four Claude Code models", () => {
    const ids = adapter.models.list.map((m) => m.id).sort();
    expect(ids).toEqual(["claude-fable-5", "claude-haiku-4-5", "claude-opus-5", "claude-sonnet-5"]);
  });
});
