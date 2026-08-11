import { describe, expect, test } from "bun:test";
import type { ProxyRequest, RequestLimits, StreamEvent } from "../../src/application/contracts";
import {
  normalizeChatRequest, normalizeMessagesRequest, normalizeResponsesRequest,
  buildChatPayload, buildMessagesPayload, buildResponsesPayload,
  mapChatUsage, mapAnthropicUsage, mapResponsesUsage,
  resolveWireSurface, parseRequestBody, lookupProxyEndpoint, toOpenAIImageUrl,
} from "../../src/open-sse/translate";
import { decodeNonStreamResponse, translateNonStreamResponse } from "../../src/open-sse/translate/response/index";
import { lookupResponseTranslation } from "../../src/open-sse/translate/registry";
import { ProtocolCodecError, StreamDecodeError } from "../../src/open-sse/translate/errors";
import { ProviderAdapterError, parseRetryAfterSeconds, toProviderCallError } from "../../src/open-sse/transport/errors";
import { AbortCoordinator } from "../../src/open-sse/transport/abort-coordinator";
import { parseSseData, decodeSseEvents } from "../../src/open-sse/transport/sse-decoder";
import { mapSseStream } from "../../src/open-sse/transport/stream-mapper";
import { appendTerminalError } from "../../src/open-sse/handlers";
import { capabilitiesOf } from "../../src/open-sse/transport/catalog";
import { encodeSurfaceStream } from "../../src/open-sse/transport/surface-encoder";
import { createOpenAIChatStreamMapper, createOpenAIResponsesStreamMapper } from "../../src/open-sse/transport/protocols/openai";
import { createAnthropicMessagesStreamMapper } from "../../src/open-sse/transport/protocols/anthropic";
import { ensureToolCallIds, fixMissingToolResponses } from "../../src/open-sse/translate/concerns/tools";
import type { NormalizeInput } from "../../src/application/protocols";
import { isProtocolError } from "../../src/application/protocols";
import { buildCachePlan, applyCachePlan } from "../../src/application/cache";
import { OpenAIAdapter } from "../../src/providers/openai";
import { CodexAdapter } from "../../src/providers/codex";
import { buildGeminiPayload } from "../../src/open-sse/translate/request/gemini";

const limits: RequestLimits = { maxBodyBytes: 10_000_000, connectTimeoutMs: 10_000, firstByteTimeoutMs: 30_000, idleTimeoutMs: 30_000, totalTimeoutMs: 120_000 };
function ni(signal?: AbortSignal): NormalizeInput { return { signal: signal ?? new AbortController().signal, limits }; }
function chatReq(o: Partial<ProxyRequest> = {}): ProxyRequest { return { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [], stream: false, responseFormat: "text", reasoning: "default", maxOutputTokens: null, images: [], sourceSurface: "openai-chat", signal: new AbortController().signal, limits, ...o }; }
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const x of it) out.push(x); return out; }
function sseBody(lines: string[]): ReadableStream<Uint8Array> { const e = new TextEncoder(); return new ReadableStream({ start(c) { for (const l of lines) c.enqueue(e.encode(`data: ${l}\n\n`)); c.close(); } }); }

describe("surface routing", () => {
  test("lookupProxyEndpoint maps all proxy paths", () => {
    expect(lookupProxyEndpoint("/v1/chat/completions")?.surface).toBe("openai-chat");
    expect(lookupProxyEndpoint("/v1/messages")?.surface).toBe("anthropic-messages");
    expect(lookupProxyEndpoint("/v1/responses")?.surface).toBe("openai-responses");
    expect(lookupProxyEndpoint("/v1/models")).toBe(null);
  });
  test("parseRequestBody returns typed errors for oversized, empty, NDJSON, arrays", () => {
    expect(isProtocolError(parseRequestBody('{"x":"longer than five"}', { ...limits, maxBodyBytes: 5 }))).toBe(true);
    expect(isProtocolError(parseRequestBody("", limits))).toBe(true);
    expect(isProtocolError(parseRequestBody('{"a":1}\n{"b":2}', limits))).toBe(true);
    expect(isProtocolError(parseRequestBody("[1,2]", limits))).toBe(true);
    expect(isProtocolError(parseRequestBody('{"a":1}', limits))).toBe(false);
  });
  test("resolveWireSurface prefers client surface, falls back, or null", () => {
    const c = capabilitiesOf({ surfaces: ["openai-chat", "openai-responses"] });
    const meta = { id: "test", displayName: "Test", protocol: "openai" as const, credentialKind: "api_key" as const };
    expect(resolveWireSurface(meta, c, "openai-chat")).toBe("openai-chat");
    expect(resolveWireSurface(meta, capabilitiesOf({ surfaces: ["images"] }), "openai-chat")).toBe(null);
  });
  test("native OpenAI routes Chat-compatible clients to Responses upstream", () => {
    const adapter = new OpenAIAdapter();
    expect(adapter.capabilities.surfaces).not.toContain("openai-chat");
    expect(resolveWireSurface(adapter.metadata, adapter.capabilities, "openai-chat")).toBe("openai-responses");
    expect(resolveWireSurface(adapter.metadata, adapter.capabilities, "openai-responses")).toBe("openai-responses");
  });

  test("Codex unwraps durable OAuth bundles before sending the Responses request", async () => {
    const payload = btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const accessToken = `header.${payload}.signature`;
    const credential = JSON.stringify({ accessToken, providerAccountId: "account-123", email: "user@example.com" });
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), init };
      return new Response(`data: {"type":"response.reasoning_summary_text.delta","delta":"think"}\n\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", object: "response", output: [], output_text: "", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const adapter = new CodexAdapter();
      const result = await adapter.call({
        target: adapter.resolveTarget("gpt-5.4", "openai-responses"),
        request: chatReq({ model: "codex/gpt-5.4" }),
        credential,
        network: { proxyId: null, url: null, release: async () => {} },
        signal: new AbortController().signal,
        headers: new Headers({ authorization: "Bearer client-secret", "x-api-key": "client-secret", "user-agent": "claude-cli/client", "x-client-request-id": "client-request" }),
      });
      expect(result.mode).toBe("non_stream");
      if (result.mode === "non_stream") {
        expect(result.body.output_text).toBe("hello");
        expect(JSON.stringify(result.body.output)).toContain("think");
      }
      expect(request?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(new Headers(request?.init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
      const sent = JSON.parse(String(request?.init?.body)) as Record<string, unknown>;
      expect(sent.model).toBe("gpt-5.4");
      expect(new Headers(request?.init?.headers).get("chatgpt-account-id")).toBe("account-123");
      expect(new Headers(request?.init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
      expect(new Headers(request?.init?.headers).get("x-api-key")).toBe(null);
      expect(new Headers(request?.init?.headers).get("user-agent")).toBe("codex-cli/0.144.1");
      expect(new Headers(request?.init?.headers).get("x-client-request-id")).toBe(null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Chat Completions normalization and payload", () => {
  test("normalizes text request; rejects bad model/role/stream/response_format", () => {
    const r = normalizeChatRequest({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }, ni());
    expect(r.ok).toBe(true); if (!r.ok) return; expect(r.request.sourceSurface).toBe("openai-chat");
    expect(normalizeChatRequest({ model: "  ", messages: [] }, ni()).ok).toBe(false);
    expect(normalizeChatRequest({ model: "m", messages: [{ role: "wizard", content: "x" }] }, ni()).ok).toBe(false);
    expect(normalizeChatRequest({ model: "m", messages: [], stream: "yes" }, ni()).ok).toBe(false);
    expect(normalizeChatRequest({ model: "m", messages: [], response_format: { type: "yaml" } }, ni()).ok).toBe(false);
  });
  test("normalizes Chat max output token fields", () => {
    const legacy = normalizeChatRequest({ model: "m", max_tokens: 321, messages: [{ role: "user", content: "hi" }] }, ni());
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.request.maxOutputTokens).toBe(321);

    const completion = normalizeChatRequest({ model: "m", max_tokens: 321, max_completion_tokens: 654, messages: [{ role: "user", content: "hi" }] }, ni());
    expect(completion.ok).toBe(true);
    if (!completion.ok) return;
    expect(completion.request.maxOutputTokens).toBe(654);
    expect(normalizeChatRequest({ model: "m", max_tokens: -1, messages: [] }, ni()).ok).toBe(false);
  });
  test("tool role tags tool_result; reasoning_content forces enabled; image classified; SSRF rejected", () => {
    const r = normalizeChatRequest({ model: "m", messages: [
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "42" },
    ] }, ni());
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.request.messages[1]?.content[0]?.type).toBe("tool_result");
    expect(r.request.messages[1]?.content[0]?.toolCallId).toBe("c1");
    const r2 = normalizeChatRequest({ model: "m", messages: [{ role: "assistant", content: "", reasoning_content: "thinking" }] }, ni());
    expect(r2.ok).toBe(true); if (!r2.ok) return; expect(r2.request.reasoning).toBe("enabled");
    const r3 = normalizeChatRequest({ model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] }] }, ni());
    expect(r3.ok).toBe(true); if (!r3.ok) return; expect(r3.request.images[0]?.kind).toBe("data");
    expect(normalizeChatRequest({ model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://127.0.0.1/x.png" } }] }] }, ni()).ok).toBe(false);
  });
  test("payload: stream_options, tools, response_format, tool_calls, reasoning", () => {
    expect(buildChatPayload(chatReq({ stream: true })).stream_options).toEqual({ include_usage: true });
    const p = buildChatPayload(chatReq({ tools: [{ name: "f", description: "d", inputSchema: { type: "object" } }], responseFormat: "json_object", maxOutputTokens: 100, reasoning: "enabled" }));
    expect((p.tools as readonly unknown[])[0]).toEqual({ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } });
    expect(p.response_format).toEqual({ type: "json_object" }); expect(p.max_tokens).toBe(100); expect(p.reasoning_effort).toBe("medium");
    expect(toOpenAIImageUrl({ kind: "data", value: "abc", mediaType: "image/jpeg" })).toBe("data:image/jpeg;base64,abc");
    expect(() => toOpenAIImageUrl({ kind: "file" as const, value: "x", mediaType: null })).toThrow(ProtocolCodecError);
  });
  test("removes unsupported JSON Schema keywords from Gemini tool declarations", () => {
    const payload = buildGeminiPayload(chatReq({
      tools: [{
        name: "search",
        description: "Search",
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1 },
            options: {
              type: "object",
              properties: { limit: { type: "integer", minimum: 1 } },
              additionalProperties: false,
            },
          },
          required: ["query"],
        },
      }],
    }));
    const parameters = (((payload.tools as readonly Record<string, unknown>[])[0]?.functionDeclarations as readonly Record<string, unknown>[])[0]?.parameters);
    expect(parameters).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
        options: { type: "object", properties: { limit: { type: "integer" } } },
      },
      required: ["query"],
    });
    const continuation = buildGeminiPayload(chatReq({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", toolName: "search", toolCallId: "call_search", toolArguments: "{}" }] },
        { role: "user", content: [{ type: "tool_result", toolCallId: "call_search", text: "{\"ok\":true}" }] },
      ],
    }));
    const continuationContents = continuation.contents as readonly Record<string, unknown>[];
    expect((continuationContents[1]?.parts as readonly unknown[])[0]).toEqual({ functionResponse: { name: "search", response: { ok: true }, id: "call_search" } });
  });
  test("preserves Anthropic search results in Chat provider user context", () => {
    const payload = buildChatPayload(chatReq({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", toolName: "WebSearch", toolCallId: "call_1", toolArguments: JSON.stringify({ query: "risuncode" }) }] },
        { role: "user", content: [{ type: "tool_result", toolCallId: "call_1", text: "{\"type\":\"web_search_tool_result\",\"content\":\"found\"}" }] },
      ],
    }));
    expect((payload.messages as readonly Record<string, unknown>[])[1]?.content).toContain("web_search_tool_result");
  });
  test("Chat rejects Responses-only reasoning mode and context", () => {
    expect(normalizeChatRequest({ model: "m", reasoning: { mode: "pro" }, messages: [] }, ni()).ok).toBe(false);
    expect(normalizeChatRequest({ model: "m", reasoning: { context: "all_turns" }, messages: [] }, ni()).ok).toBe(false);
  });
  test("aborted signal rejects before normalization", () => {
    const ac = new AbortController(); ac.abort();
    expect(normalizeChatRequest({ model: "m", messages: [] }, ni(ac.signal)).ok).toBe(false);
  });
});

describe("Anthropic Messages normalization and payload", () => {
  test("requires max_tokens; accepts system messages; system becomes leading message", () => {
    expect(normalizeMessagesRequest({ model: "c", messages: [{ role: "user", content: "hi" }] }, ni()).ok).toBe(false);
    const r = normalizeMessagesRequest({ model: "c", max_tokens: 1024, system: "sys", messages: [{ role: "user", content: "hi" }] }, ni());
    expect(r.ok).toBe(true); if (!r.ok) return; expect(r.request.messages[0]?.role).toBe("system");
    const r2 = normalizeMessagesRequest({ model: "c", max_tokens: 1024, messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }] }, ni());
    expect(r2.ok).toBe(true); if (!r2.ok) return; expect(r2.request.messages[0]?.role).toBe("system");
  });
  test("preserves thinking as hidden reasoning while forcing enabled mode", () => {
    const r = normalizeMessagesRequest({ model: "c", max_tokens: 1024, messages: [{ role: "user", content: [{ type: "thinking", thinking: "p" }, { type: "text", text: "q" }] }] }, ni());
    expect(r.ok).toBe(true); if (!r.ok) return; expect(r.request.reasoning).toBe("enabled"); expect(r.request.messages[0]?.content).toHaveLength(2); expect(r.request.messages[0]?.content[0]?.type).toBe("reasoning");
    const r2 = normalizeMessagesRequest({ model: "c", max_tokens: 1024, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "s", input: { q: "x" } }] }] }, ni());
    expect(r2.ok).toBe(true); if (!r2.ok) return; expect(r2.request.messages[0]?.content[0]?.toolArguments).toBe(JSON.stringify({ q: "x" }));
  });
  test("converts Anthropic thinking blocks into Responses reasoning items", () => {
    const r = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "prior", signature: "anthropic-signature" }] }],
    }, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const input = buildResponsesPayload(r.request).input as readonly Record<string, unknown>[];
    expect(input).toContainEqual({ type: "reasoning", summary: [{ type: "summary_text", text: "prior" }] });
    expect(input.some((item) => item.type === "thinking")).toBe(false);
  });
  test("maps Anthropic tool_result messages to Responses function_call_output", () => {
    const r = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_GituTSNbE7QONnysXu4r9rxT", name: "Skill", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_GituTSNbE7QONnysXu4r9rxT", content: "loaded" }] },
      ],
    }, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.messages[1]?.role).toBe("tool");
    const input = buildResponsesPayload(r.request).input as readonly Record<string, unknown>[];
    expect(input).toContainEqual({ type: "function_call", call_id: "call_GituTSNbE7QONnysXu4r9rxT", name: "Skill", arguments: "{}" });
    expect(input).toContainEqual({ type: "function_call_output", call_id: "call_GituTSNbE7QONnysXu4r9rxT", output: "loaded" });
  });
  test("accepts Claude Code adaptive thinking and normalizes it to enabled reasoning", () => {
    const r = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "hi" }],
    }, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.reasoning).toBe("enabled");
  });
  test("passes oversized Claude Code text blocks without mutating the raw request", () => {
    const oversized = "x".repeat(512_001);
    const body = {
      model: "c",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
        { role: "assistant", content: [{ type: "text", text: "keep" }, { type: "text", text: oversized }] },
      ],
    };
    const r = normalizeMessagesRequest(body, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.messages[3]?.content[1]?.text).toBe(oversized);
    const originalContent = body.messages[3]?.content;
    expect(Array.isArray(originalContent) ? originalContent[1]?.text : undefined).toBe(oversized);
  });
  test("passes oversized Anthropic tool output through Responses translation", () => {
    const oversized = "result".repeat(100_000);
    const r = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_large", content: oversized }],
      }],
    }, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const input = buildResponsesPayload(r.request).input as readonly Record<string, unknown>[];
    const output = input.find((item) => item.type === "function_call_output")?.output;
    expect(output).toBe(oversized);
  });
  test("preserves Claude web search natively and maps it to Responses web_search", () => {
    const r = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
        allowed_domains: ["anthropic.com"],
        blocked_domains: ["example.invalid"],
        user_location: { type: "approximate", country: "ID" },
      }],
      messages: [{ role: "user", content: "search" }],
    }, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.tools[0]?.nativeType).toBe("web_search_20250305");
    expect(r.request.tools[0]?.inputSchema.required).toEqual(["query"]);
    expect(r.request.tools[0]?.nativeOptions).toEqual({
      max_uses: 5,
      allowed_domains: ["anthropic.com"],
      blocked_domains: ["example.invalid"],
      user_location: { type: "approximate", country: "ID" },
    });
    const payload = buildMessagesPayload(r.request, capabilitiesOf({ surfaces: ["anthropic-messages"], reasoning: true }));
    expect(payload.tools).toEqual([{
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
      allowed_domains: ["anthropic.com"],
      blocked_domains: ["example.invalid"],
      user_location: { type: "approximate", country: "ID" },
    }]);
    expect(buildResponsesPayload(r.request).tools).toEqual([{ type: "web_search" }]);
  });
  test("projects function-shaped Claude WebSearch tools to hosted Responses search", () => {
    const r = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      tools: [{ name: "WebSearch", description: "Search the web", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
      messages: [{ role: "user", content: "search" }],
    }, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(buildResponsesPayload(r.request).tools).toEqual([{ type: "web_search" }]);
  });
  test("preserves Claude web fetch versions and options natively", () => {
    const r = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      tools: [{
        type: "web_fetch_20260318",
        name: "web_fetch",
        max_uses: 3,
        allowed_domains: ["docs.anthropic.com"],
      }],
      messages: [{ role: "user", content: "fetch" }],
    }, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.tools[0]?.nativeType).toBe("web_fetch_20260318");
    expect(r.request.tools[0]?.inputSchema.required).toEqual(["url"]);
    expect(r.request.tools[0]?.nativeOptions).toEqual({
      max_uses: 3,
      allowed_domains: ["docs.anthropic.com"],
    });
    expect(buildMessagesPayload(r.request, capabilitiesOf({ surfaces: ["anthropic-messages"], reasoning: true })).tools).toEqual([{
      type: "web_fetch_20260318",
      name: "web_fetch",
      max_uses: 3,
      allowed_domains: ["docs.anthropic.com"],
    }]);
  });
  test("rejects native server tools on incompatible projections", () => {
    const webFetch = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      tools: [{ type: "web_fetch_20260318", name: "web_fetch" }],
      messages: [{ role: "user", content: "fetch" }],
    }, ni());
    expect(webFetch.ok).toBe(true);
    if (!webFetch.ok) return;
    expect(() => buildResponsesPayload(webFetch.request)).toThrow(ProtocolCodecError);

    const webSearch = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      tools: [{ type: "web_search_20260318", name: "web_search" }],
      messages: [{ role: "user", content: "search" }],
    }, ni());
    expect(webSearch.ok).toBe(true);
    if (!webSearch.ok) return;
    expect(() => buildChatPayload(webSearch.request)).toThrow(ProtocolCodecError);
  });
  test("preserves Advanced Tool Use definitions and MCP connector configuration", () => {
    const r = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      mcp_servers: [{ type: "url", url: "https://mcp.example.test/sse", name: "example" }],
      tools: [
        { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
        {
          name: "query_database",
          description: "Query the database",
          input_schema: { type: "object", properties: { sql: { type: "string" } } },
          defer_loading: true,
          allowed_callers: ["code_execution_20260120"],
          input_examples: [{ sql: "select 1" }],
        },
        { type: "mcp_toolset", mcp_server_name: "example" },
      ],
      messages: [{ role: "user", content: "query" }],
    }, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.tools[0]?.nativeType).toBe("tool_search_tool_regex_20251119");
    expect(r.request.tools[1]?.deferLoading).toBe(true);
    expect(r.request.tools[1]?.allowedCallers).toEqual(["code_execution_20260120"]);
    expect(r.request.tools[1]?.inputExamples).toEqual([{ sql: "select 1" }]);
    expect(buildMessagesPayload(r.request, capabilitiesOf({ surfaces: ["anthropic-messages"], reasoning: true })).tools).toEqual([
      { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      {
        name: "query_database",
        description: "Query the database",
        input_schema: { type: "object", properties: { sql: { type: "string" } } },
        defer_loading: true,
        allowed_callers: ["code_execution_20260120"],
        input_examples: [{ sql: "select 1" }],
      },
      { type: "mcp_toolset", mcp_server_name: "example" },
    ]);
    expect((buildMessagesPayload(r.request, capabilitiesOf({ surfaces: ["anthropic-messages"], reasoning: true })).mcp_servers)).toEqual([
      { type: "url", url: "https://mcp.example.test/sse", name: "example" },
    ]);
  });
  test("preserves versioned code execution as an Anthropic server tool", () => {
    const r = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      tools: [{ type: "code_execution_20260120", name: "code_execution" }],
      messages: [{ role: "user", content: "run it" }],
    }, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(buildMessagesPayload(r.request, capabilitiesOf({ surfaces: ["anthropic-messages"], reasoning: true })).tools).toEqual([
      { type: "code_execution_20260120", name: "code_execution" },
    ]);
  });
  test("preserves native web search result blocks as tool-result text", () => {
    const r = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "servertoolu_1",
          content: [{ type: "web_search_result", title: "Risun", url: "https://github.com/risunCode", content: "Profile" }],
        }],
      }],
    }, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.messages[0]?.content[0]?.text).toContain("Risun");
    expect(r.request.messages[0]?.content[0]?.text).toContain("https://github.com/risunCode");
    expect(r.request.tools).toHaveLength(1);
  });
  test("keeps Claude server-tool blocks as bounded native continuation context", () => {
    const r = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      messages: [{
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "risuncode" } },
          { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", title: "Risun" }] },
        ],
      }],
    }, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.messages[0]?.content[0]?.type).toBe("native");
    expect(r.request.messages[0]?.content[0]?.nativeType).toBe("server_tool_use");
    expect(r.request.messages[0]?.content[0]?.nativePayload).toMatchObject({ name: "web_search" });
    expect(r.request.messages[0]?.content[1]?.nativeType).toBe("web_search_tool_result");
  });
  test("accepts future native tool types and preserves them on the Anthropic surface", () => {
    const futureTool = { type: "future_tool_20270101", name: "future_tool", configuration: { mode: "opaque" } };
    const r = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      tools: [futureTool],
      messages: [{ role: "user", content: [{ type: "future_block", payload: { keep: true } }] }],
    }, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.tools[0]?.nativeType).toBe("future_tool_20270101");
    const payload = buildMessagesPayload(r.request, capabilitiesOf({ surfaces: ["anthropic-messages"] }));
    expect(payload.tools).toEqual([futureTool]);
    expect(payload.messages).toEqual([{ role: "user", content: [{ type: "future_block", payload: { keep: true } }] }]);
  });
  test("adapts future native tools when the target is Responses", () => {
    const r = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      tools: [{ type: "future_tool_20270101", name: "future_tool" }],
      messages: [{ role: "user", content: "adapt" }],
    }, ni());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(buildResponsesPayload(r.request).tools).toEqual([{
      type: "function",
      name: "future_tool",
      description: undefined,
      parameters: {},
    }]);
  });
test("emits explicit OpenAI cache breakpoints only for GPT-5.6", () => {
  const request = chatReq({
    model: "gpt-5.6",
    cacheKey: "tenant-session-prefix",
    messages: [
      { role: "system", content: [{ type: "text", text: "stable instructions", cacheControl: "ephemeral" }] },
      { role: "user", content: [{ type: "text", text: "changing question" }] },
    ],
  });
  const chatPayload = buildChatPayload(request);
  expect(chatPayload.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
  expect(chatPayload.messages).toEqual([
    { role: "system", content: [{ type: "text", text: "stable instructions", prompt_cache_breakpoint: { mode: "explicit" } }] },
    { role: "user", content: "changing question" },
  ]);

  const responsesPayload = buildResponsesPayload({ ...request, sourceSurface: "openai-responses" });
  expect(responsesPayload.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
  expect(responsesPayload.input).toContainEqual({
    role: "system",
    content: [{ type: "input_text", text: "stable instructions", prompt_cache_breakpoint: { mode: "explicit" } }],
  });
  expect(buildChatPayload({ ...request, model: "gpt-5" }).prompt_cache_options).toBeUndefined();
});

test("scopes generated cache keys to the caller affinity", () => {
  const request = chatReq({
    model: "gpt-5.6",
    messages: [{ role: "system", content: [{ type: "text", text: "stable" }] }],
  });
  const plan = buildCachePlan(request);
  const first = applyCachePlan(request, plan, "api_key:key-a");
  const repeat = applyCachePlan(request, plan, "api_key:key-a");
  const other = applyCachePlan(request, plan, "api_key:key-b");
  expect(first.cacheKey).toBe(repeat.cacheKey);
  expect(first.cacheKey).not.toBe(other.cacheKey);
});
  test("payload: thinking capped at 32000; invalid JSON tool args throws; cache control applied", () => {
    const caps = capabilitiesOf({ surfaces: ["anthropic-messages"], reasoning: true, explicitCache: true, promptCacheKey: true });
    expect(buildMessagesPayload(chatReq({ sourceSurface: "anthropic-messages", reasoning: "enabled", maxOutputTokens: 100000 }), caps).thinking).toEqual({ type: "enabled", budget_tokens: 32000 });
    expect(() => buildMessagesPayload(chatReq({ sourceSurface: "anthropic-messages", messages: [{ role: "assistant", content: [{ type: "tool_use", toolName: "s", toolCallId: "t1", toolArguments: "bad" }] }] }), caps)).toThrow(ProtocolCodecError);
    const p = buildMessagesPayload(chatReq({ sourceSurface: "anthropic-messages", cacheKey: "ck", messages: [{ role: "system", content: [{ type: "text", text: "s" }] }, { role: "user", content: [{ type: "text", text: "u" }] }] }), caps);
    expect(Array.isArray(p.system)).toBe(true);
  });
  test("preserves explicit OpenAI cache keys and maps them to Anthropic markers", () => {
    const normalized = normalizeChatRequest({ model: "m", prompt_cache_key: "external-key", messages: [{ role: "user", content: "hi" }] }, ni());
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.request.cacheKey).toBe("external-key");
    const payload = buildMessagesPayload(chatReq({
      sourceSurface: "anthropic-messages",
      cacheKey: "external-key",
      wirePayload: { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }], stream: false },
    }), capabilitiesOf({ surfaces: ["anthropic-messages"], reasoning: true, explicitCache: true, promptCacheKey: true }));
    const rawMessages: unknown = payload.messages;
    const firstMessage = Array.isArray(rawMessages) ? rawMessages[0] : undefined;
    const content = typeof firstMessage === "object" && firstMessage !== null && "content" in firstMessage ? firstMessage.content : undefined;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) return;
    const firstContent = content[0];
    expect(firstContent && typeof firstContent === "object" && "cache_control" in firstContent ? firstContent.cache_control : undefined).toEqual({ type: "ephemeral" });
  });
});

test("maps explicit Anthropic cache markers to an OpenAI prompt cache key", () => {
  const normalized = normalizeMessagesRequest({
    model: "m",
    max_tokens: 10,
    messages: [{ role: "user", content: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }] }],
  }, ni());
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) return;
  const request = applyCachePlan(normalized.request, buildCachePlan(normalized.request));
  expect(request.cacheKey).toMatch(/^[0-9a-f]{16}$/);
  expect(buildChatPayload(request)["prompt_cache_key"]).toBe(request.cacheKey);
});
  test("round-trips context management and compaction blocks", () => {
    const r = normalizeMessagesRequest({
      model: "claude-opus-5",
      max_tokens: 1024,
      context_management: { edits: [{ type: "compact_20260112" }] },
      messages: [{ role: "assistant", content: [{ type: "compaction", content: "summary" }] }],
    }, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.contextManagement).toEqual({ edits: [{ type: "compact_20260112" }] });
    expect(buildMessagesPayload(r.request, capabilitiesOf({ surfaces: ["anthropic-messages"] })).context_management).toEqual({ edits: [{ type: "compact_20260112" }] });
    expect((buildMessagesPayload(r.request, capabilitiesOf({ surfaces: ["anthropic-messages"] })).messages as readonly Record<string, unknown>[])[0]?.content).toEqual([{ type: "compaction", content: "summary" }]);
  });
test("round-trips Responses compaction configuration and opaque items", () => {
  const r = normalizeResponsesRequest({
    model: "gpt-5.6",
    context_management: [{ type: "compaction", compact_threshold: 200000 }],
    input: [
      { type: "compaction", encrypted_content: "opaque" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  }, ni());
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.request.contextManagement).toEqual([{ type: "compaction", compact_threshold: 200000 }]);
  const input = buildResponsesPayload(r.request).input as readonly Record<string, unknown>[];
  expect(input[0]).toEqual({ type: "compaction", encrypted_content: "opaque" });
  expect(input[1]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] });
});
test("converts Messages context-management edits for Responses providers", () => {
  const payload = buildResponsesPayload(chatReq({ contextManagement: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } }));
  expect(payload.context_management).toEqual([{ type: "clear_thinking_20251015", keep: "all" }]);
});
test("can omit remote context management for Codex and Anthropic adapters", () => {
  const request = chatReq({ contextManagement: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } });
  expect(buildResponsesPayload(request, { includeContextManagement: false }).context_management).toBeUndefined();
  expect(buildMessagesPayload(request, capabilitiesOf({ surfaces: ["anthropic-messages"] }), { includeContextManagement: false }).context_management).toBeUndefined();
});

describe("OpenAI Responses normalization and payload", () => {
  test("input string normalizes; instructions become system; function_call items fold", () => {
    const r = normalizeResponsesRequest({ model: "o1", input: "hi" }, ni());
    expect(r.ok).toBe(true); if (!r.ok) return; expect(r.request.messages[0]?.content[0]).toEqual({ type: "text", text: "hi" });
    const r2 = normalizeResponsesRequest({ model: "o1", input: "hi", instructions: "sys" }, ni());
    expect(r2.ok).toBe(true); if (!r2.ok) return; expect(r2.request.messages[0]?.role).toBe("system");
    const r3 = normalizeResponsesRequest({ model: "o1", input: [{ type: "function_call", call_id: "c1", name: "s", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "r" }] }, ni());
    expect(r3.ok).toBe(true); if (!r3.ok) return; expect(r3.request.messages[0]?.content[0]?.type).toBe("tool_use");
  });
  test("reasoning blocks stay ordered and phase/mode/context round-trip", () => {
    const r = normalizeResponsesRequest({
      model: "gpt-5.6",
      reasoning: { effort: "high", summary: "detailed", mode: "pro", context: "all_turns" },
      input: [
        { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "prior thought" }] },
        { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "answer" }] },
      ],
    }, ni());
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.request.messages[0]?.reasoningItemsBefore).toEqual([{ type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "prior thought" }] }]);
    expect(r.request.messages[0]?.phase).toBe("final_answer");
    expect(buildResponsesPayload(r.request).reasoning).toEqual({ effort: "high", summary: "detailed", mode: "pro", context: "all_turns" });
    expect((buildResponsesPayload(r.request).input as readonly unknown[])[0]).toEqual({ type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "prior thought" }] });
    expect((buildResponsesPayload(r.request).input as readonly unknown[])[1]).toMatchObject({ role: "assistant", phase: "final_answer" });
  });
  test("forwards legacy reasoning_effort into the Responses reasoning object", () => {
    const r = normalizeResponsesRequest({ model: "gpt-5.6", reasoning_effort: "high", input: "hi" }, ni());
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.request.reasoning).toBe("enabled");
    expect(buildResponsesPayload(r.request).reasoning).toEqual({ effort: "high", summary: "concise" });
  });
  test("preserves reasoning blocks as hidden semantic items; refusal never visible; payload defaults to concise summaries", () => {
    const r = normalizeResponsesRequest({ model: "o1", input: [{ type: "message", role: "user", content: [{ type: "reasoning" }, { type: "input_text", text: "real" }] }] }, ni());
    expect(r.ok).toBe(true); if (!r.ok) return; expect(r.request.reasoning).toBe("enabled"); expect(r.request.messages[0]?.content).toHaveLength(2); expect(r.request.messages[0]?.content[0]?.type).toBe("reasoning");
    const r2 = normalizeResponsesRequest({ model: "o1", input: [{ type: "message", role: "assistant", content: [{ type: "refusal" }] }] }, ni());
    expect(r2.ok).toBe(true); if (!r2.ok) return; expect(r2.request.messages[0]?.content[0]?.type).toBe("unknown");
    expect(buildResponsesPayload(chatReq({ sourceSurface: "openai-responses", reasoning: "enabled" })).reasoning).toEqual({ effort: "medium", summary: "concise" });
  });
});

describe("usage mapping", () => {
  test("chat: maps tokens, computes total, surfaces cache read/write and reasoning", () => {
    expect(mapChatUsage({ prompt_tokens: 5, completion_tokens: 7 }).totalTokens).toBe(12);
    expect(mapChatUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } }).cacheReadTokens).toBe(8);
    expect(mapChatUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cache_write_tokens: 2 } }).cacheWriteTokens).toBe(2);
    expect(mapChatUsage({ prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } }).reasoningTokens).toBe(3);
  });
  test("anthropic: maps tokens, surfaces cache read/write", () => {
    const u = mapAnthropicUsage({ input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 });
    expect(u.totalTokens).toBe(8); expect(u.cacheReadTokens).toBe(100); expect(u.cacheWriteTokens).toBe(50);
  });
  test("responses: maps tokens, surfaces cache read/write and reasoning", () => {
    expect(mapResponsesUsage({ input_tokens: 5, output_tokens: 7 }).totalTokens).toBe(12);
    expect(mapResponsesUsage({ input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 8, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } }).cacheReadTokens).toBe(8);
    expect(mapResponsesUsage({ input_tokens: 10, output_tokens: 5, input_tokens_details: { cache_write_tokens: 2 } }).cacheWriteTokens).toBe(2);
    expect(mapResponsesUsage({ input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } }).reasoningTokens).toBe(3);
  });
});
describe("semantic non-stream response translation", () => {
  test("Chat to Anthropic preserves text, reasoning, tool IDs, arguments, and usage", () => {
    const body = {
      id: "chat_1",
      model: "gpt-5.6",
      choices: [{
        message: {
          role: "assistant",
          content: "answer",
          reasoning_content: "private",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } },
    };
    const translated = translateNonStreamResponse(body, "openai-chat", "anthropic-messages", "gpt-5.6");
    expect(translated.content).toEqual([
      { type: "thinking", thinking: "private" },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
    ]);
    expect(translated.stop_reason).toBe("tool_use");
    expect(translated.usage).toMatchObject({ input_tokens: 5, output_tokens: 3 });
  });

  test("Anthropic to Chat keeps reasoning separate from visible text and restores tool calls", () => {
    const body = {
      id: "msg_1",
      model: "claude",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    const translated = translateNonStreamResponse(body, "anthropic-messages", "openai-chat", "claude");
    const choice = (translated.choices as readonly Record<string, unknown>[])[0] as Record<string, unknown>;
    const message = choice.message as Record<string, unknown>;
    expect(message.content).toBe("answer");
    expect(message.reasoning_content).toBe("private");
    expect(message.tool_calls).toEqual([{ id: "toolu_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }]);
    expect(choice.finish_reason).toBe("tool_calls");
  });
  test("decodes native Anthropic blocks and preserves pause_turn in non-stream responses", () => {
    const resultBlock = { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", title: "Example", url: "https://example.com" }] };
    const body = {
      id: "msg_web",
      model: "claude",
      content: [
        { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "latest" } },
        resultBlock,
      ],
      stop_reason: "pause_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    const document = decodeNonStreamResponse("anthropic-messages", body, "claude");
    expect(document.events).toContainEqual({
      type: "server_tool_result",
      block: resultBlock,
    });
    expect(document.events.at(-1)).toEqual({ type: "message_stop", reason: "pause_turn" });
  });
  test("decodes Responses web_search_call as a native server-tool block", () => {
    const body = {
      id: "resp_web",
      output: [
        { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "risuncode" } },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Risun Code", annotations: [] }] },
      ],
      status: "completed",
    };
    const document = decodeNonStreamResponse("openai-responses", body, "claude");
    expect(document.events).toContainEqual({
      type: "native_block_start",
      index: 1,
      block: { type: "server_tool_use", id: "ws_1", name: "web_search", input: { query: "risuncode" } },
    });
    expect(document.events).toContainEqual({ type: "native_block_stop", index: 1 });
  });

  test("Chat and Responses projections preserve function-call IDs and reasoning semantics", () => {
    const chat = {
      id: "chat_2",
      model: "gpt-5.6",
      choices: [{ message: { role: "assistant", content: "done", reasoning_content: "private", tool_calls: [{ id: "call_2", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] }, finish_reason: "tool_calls" }],
    };
    const responses = translateNonStreamResponse(chat, "openai-chat", "openai-responses", "gpt-5.6");
    expect(responses.output).toContainEqual({ type: "reasoning", id: "chat_2-reasoning", summary: [{ type: "summary_text", text: "private" }] });
    expect(responses.output).toContainEqual({ type: "function_call", id: "call_2", call_id: "call_2", name: "lookup", arguments: "{\"q\":\"x\"}", status: "completed" });
    const roundTrip = translateNonStreamResponse(responses, "openai-responses", "openai-chat", "gpt-5.6");
    const roundChoice = (roundTrip.choices as readonly Record<string, unknown>[])[0] as Record<string, unknown>;
    const roundMessage = roundChoice.message as Record<string, unknown>;
    expect(roundMessage.reasoning_content).toBe("private");
    expect(roundMessage.tool_calls).toEqual([{ id: "call_2", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }]);
  });

  test("same-surface bodies are preserved exactly and unsupported edges fail typed", () => {
    const body = { id: "same", choices: [] };
    expect(translateNonStreamResponse(body, "openai-chat", "openai-chat", "m")).toBe(body);
    expect(lookupResponseTranslation("openai-chat", "openai-responses")).toBeDefined();
    expect(() => translateNonStreamResponse(body, "anthropic-messages", "openai-responses", "m")).toThrow(ProtocolCodecError);
  });

  test("decoded non-stream events align with stream semantics", async () => {
    const body = { id: "chat_stream", model: "m", choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } };
    const nonStream = decodeNonStreamResponse("openai-chat", body, "m").events;
    const coordinator = new AbortCoordinator(new AbortController().signal);
    const streamed = await collect(mapSseStream({ body: sseBody([
      JSON.stringify({ id: "chat_stream", choices: [{ delta: { content: "hello" } }] }),
      JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 1 } }),
      "[DONE]",
    ]), coordinator, maxLineBytes: 65536 }, createOpenAIChatStreamMapper()));
    expect(nonStream.some((event) => event.type === "text_delta" && event.text === "hello")).toBe(true);
    expect(streamed.some((event) => event.type === "text_delta" && event.text === "hello")).toBe(true);
    expect(nonStream.some((event) => event.type === "usage")).toBe(true);
    expect(streamed.some((event) => event.type === "usage")).toBe(true);
    expect(nonStream[nonStream.length - 1]?.type).toBe("message_stop");
    expect(streamed[streamed.length - 1]?.type).toBe("message_stop");
  });
});


describe("SSE parsing and error classification", () => {
  test("parseSseData: [DONE] yields null; invalid JSON throws", () => {
    expect(parseSseData("[DONE]")).toBe(null);
    expect(parseSseData('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseSseData("not json")).toThrow(ProviderAdapterError);
  });
  test("parseRetryAfterSeconds: numeric, http-date, clamped, null for bad", () => {
    expect(parseRetryAfterSeconds("30", 0)).toBe(30);
    expect(parseRetryAfterSeconds(null, 0)).toBe(null);
    expect(parseRetryAfterSeconds("", 0)).toBe(null);
    expect(parseRetryAfterSeconds("999999", 0)).toBe(30);
  });
  test("toProviderCallError: aborts are client_aborted; TypeErrors are network; SyntaxErrors are internal", () => {
    const ac = new AbortController(); ac.abort();
    expect(toProviderCallError(new DOMException("aborted", "AbortError")).kind).toBe("client_aborted");
    expect(toProviderCallError(new TypeError("fetch failed")).kind).toBe("network_unavailable");
    expect(toProviderCallError(new SyntaxError("bad")).kind).toBe("internal_error");
  });
  test("ProviderAdapterError preserves retryable/routeScope/retryAt", () => {
    const e = new ProviderAdapterError({ kind: "provider_rate_limited", message: "slow down", statusCode: 429, retryable: true, routeScope: "account", retryAt: "2025-01-01T00:00:00Z" });
    const p = e.toProviderCallError();
    expect(p.retryable).toBe(true); expect(p.routeScope).toBe("account"); expect(p.retryAt).not.toBe(null);
  });
  test("StreamDecodeError is never retryable", () => {
    const e = new StreamDecodeError("stream_truncated", "ended early");
    expect(e.retryable).toBe(false);
    const p = e.toProviderCallError();
    expect(p.kind).toBe("stream_truncated");
  });
});

describe("Chat SSE mapper sequencing", () => {
  test("emits message_start, text_delta, usage, message_stop on [DONE]", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"id":"1","choices":[{"delta":{"content":"hi"}}]}',
      '{"usage":{"prompt_tokens":5,"completion_tokens":2}}',
      "[DONE]",
    ]), coordinator: coord, maxLineBytes: 65536 }, createOpenAIChatStreamMapper()));
    const types = events.map((e: StreamEvent) => e.type);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("usage");
    expect(types[types.length - 1]).toBe("message_stop");
  });
  test("tool_call deltas map to tool_call_start/delta/end", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"f","arguments":"{\\"x\\"" }}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}" }}]}}]}',
      "[DONE]",
    ]), coordinator: coord, maxLineBytes: 65536 }, createOpenAIChatStreamMapper()));
    const types = events.map((e: StreamEvent) => e.type);
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_delta");
    expect(types).toContain("tool_call_end");
  });
  test("error finish_reason maps to error stop reason", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"choices":[{"delta":{},"finish_reason":"error"}]}',
      "[DONE]",
    ]), coordinator: coord, maxLineBytes: 65536 }, createOpenAIChatStreamMapper()));
    const stop = events.find((e): e is Extract<StreamEvent, { type: "message_stop" }> => e.type === "message_stop");
    expect(stop?.reason).toBe("error");
  });
});

describe("Anthropic SSE mapper sequencing", () => {
  test("emits message_start, text_delta, usage, message_stop", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"type":"message_start","message":{"id":"m1","usage":{"input_tokens":10}}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      '{"type":"message_stop"}',
    ]), coordinator: coord, maxLineBytes: 65536 }, createAnthropicMessagesStreamMapper()));
    const types = events.map((e: StreamEvent) => e.type);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("usage");
    expect(types[types.length - 1]).toBe("message_stop");
  });
  test("tool_use maps to tool_call_start/delta/end", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"f"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
      '{"type":"content_block_stop","index":0}',
      '{"type":"message_stop"}',
    ]), coordinator: coord, maxLineBytes: 65536 }, createAnthropicMessagesStreamMapper()));
    const types = events.map((e: StreamEvent) => e.type);
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_delta");
    expect(types).toContain("tool_call_end");
  });
  test("thinking_delta mapped; stop_reason tool_use maps to tool_call", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pondering"}}',
      '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
      '{"type":"message_stop"}',
    ]), coordinator: coord, maxLineBytes: 65536 }, createAnthropicMessagesStreamMapper()));
    expect(events.some((e: StreamEvent) => e.type === "thinking_delta")).toBe(true);
    const stop = events.find((e): e is Extract<StreamEvent, { type: "message_stop" }> => e.type === "message_stop");
    expect(stop?.reason).toBe("tool_call");
  });
  test("maps compaction lifecycle events without exposing them as text", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"type":"message_start","message":{"id":"m1","usage":{"input_tokens":1}}}',
      '{"type":"content_block_start","index":0,"content_block":{"type":"compaction","name":"summary"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"compaction_delta","content":"summary"}}',
      '{"type":"content_block_stop","index":0}',
      '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      '{"type":"message_stop"}',
    ]), coordinator: coord, maxLineBytes: 65536 }, createAnthropicMessagesStreamMapper()));
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["compaction_start", "compaction_delta", "compaction_stop"]));
    expect(events.some((event) => event.type === "text_delta")).toBe(false);
  });
  test("preserves Anthropic tool search server results", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"type":"content_block_start","index":0,"content_block":{"type":"tool_search_tool_result","tool_use_id":"srvtoolu_1","content":{"type":"tool_search_tool_search_result","tool_references":[{"type":"tool_reference","tool_name":"query_database"}]}}}',
      '{"type":"message_stop"}',
    ]), coordinator: coord, maxLineBytes: 65536 }, createAnthropicMessagesStreamMapper()));
    const result = events.find((event): event is Extract<StreamEvent, { type: "server_tool_result" }> => event.type === "server_tool_result");
    expect(result?.block).toEqual({
      type: "tool_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: {
        type: "tool_search_tool_search_result",
        tool_references: [{ type: "tool_reference", tool_name: "query_database" }],
      },
    });
  });
  test("preserves native web search blocks and pause_turn through Anthropic SSE", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      JSON.stringify({ type: "message_start", message: { id: "m_web", usage: { input_tokens: 1 } } }),
      JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } }),
      JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"latest"}' } }),
      JSON.stringify({ type: "content_block_stop", index: 1 }),
      JSON.stringify({
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srv_1",
          content: [{ type: "web_search_result", title: "Example", url: "https://example.com" }],
        },
      }),
      JSON.stringify({ type: "content_block_stop", index: 2 }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 2 } }),
      JSON.stringify({ type: "message_stop" }),
    ]), coordinator: coord, maxLineBytes: 65536 }, createAnthropicMessagesStreamMapper()));
    expect(events).toEqual(expect.arrayContaining([
      { type: "native_block_start", index: 1, block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } },
      { type: "native_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"latest"}' } },
      { type: "native_block_stop", index: 1 },
      {
        type: "server_tool_result",
        block: {
          type: "web_search_tool_result",
          tool_use_id: "srv_1",
          content: [{ type: "web_search_result", title: "Example", url: "https://example.com" }],
        },
      },
      { type: "message_stop", reason: "pause_turn" },
    ]));

    async function* source(): AsyncGenerator<StreamEvent> {
      for (const event of events) yield event;
    }
    const chunks = await collect(encodeSurfaceStream("anthropic-messages", source(), "claude"));
    const output = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    expect(output).toContain('"type":"server_tool_use"');
    expect(output).toContain('"partial_json":"{\\"query\\":\\"latest\\"}"');
    expect(output).toContain('"type":"web_search_tool_result"');
    expect(output).toContain('"stop_reason":"pause_turn"');
  });

  test("maps Anthropic rate-limit stream errors to typed provider errors", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const result = collect(mapSseStream({ body: sseBody([
      '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
    ]), coordinator: coord, maxLineBytes: 65536 }, createAnthropicMessagesStreamMapper()))
      .then(() => null, (error: unknown) => error);
    const error = await result;
    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect((error as ProviderAdapterError).kind).toBe("provider_rate_limited");
  });
});

describe("Responses SSE mapper sequencing", () => {
  test("emits message_start, text_delta, usage, message_stop on completed", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"type":"response.created","response":{"id":"r1"}}',
      '{"type":"response.output_text.delta","delta":"hi"}',
      '{"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}',
    ]), coordinator: coord, maxLineBytes: 65536 }, createOpenAIResponsesStreamMapper()));
    const types = events.map((e: StreamEvent) => e.type);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("usage");
    expect(types[types.length - 1]).toBe("message_stop");
  });
  test("response.failed emits a sanitized typed error summary", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"api_key=top-secret"}}}',
    ]), coordinator: coord, maxLineBytes: 65536 }, createOpenAIResponsesStreamMapper()));
    const stop = events.find((e): e is Extract<StreamEvent, { type: "message_stop" }> => e.type === "message_stop");
    expect(stop).toMatchObject({ type: "message_stop", reason: "error", error: { kind: "provider_rate_limited", statusCode: null } });
    expect(stop?.error?.message).toBe("credential=[redacted]");
    expect(stop?.error?.message).not.toContain("top-secret");
  });
  test("response.failed closes active tool calls before the terminal error", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"echo"}}',
      '{"type":"response.failed","response":{"error":{"code":"invalid_request","message":"bad input"}}}',
    ]), coordinator: coord, maxLineBytes: 65536 }, createOpenAIResponsesStreamMapper()));
    expect(events.map((event) => event.type)).toEqual(["message_start", "tool_call_start", "tool_call_end", "message_stop"]);
    expect(events.at(-1)).toMatchObject({ type: "message_stop", reason: "error", error: { kind: "invalid_request", message: "bad input" } });
  });

  test("normalizes Codex function-call item ids onto the call id", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"type":"response.created","response":{"id":"r1"}}',
      '{"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"echo"}}',
      '{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"text\\":\\"OK\\"}"}',
      '{"type":"response.completed","response":{"status":"completed"}}',
    ]), coordinator: coord, maxLineBytes: 65536 }, createOpenAIResponsesStreamMapper()));
    const deltas = events.filter((event): event is Extract<StreamEvent, { type: "tool_call_delta" }> => event.type === "tool_call_delta");
    expect(deltas).toEqual([{ type: "tool_call_delta", callId: "call_1", delta: '{"text":"OK"}' }]);
  });
  test("maps compaction and context items as ordered events", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"type":"response.created","response":{"id":"r1"}}',
      '{"type":"response.output_item.added","output_index":0,"item":{"type":"compaction","id":"cmp_1"}}',
      '{"type":"response.output_item.done","output_index":0,"item":{"type":"compaction","id":"cmp_1","encrypted_content":"opaque"}}',
      '{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
    ]), coordinator: coord, maxLineBytes: 65536 }, createOpenAIResponsesStreamMapper()));
    const items = events.filter((event): event is Extract<StreamEvent, { type: "context_item" }> => event.type === "context_item");
    expect(items.map((item) => item.phase)).toEqual(["added", "done"]);
    expect(items[1]?.item).toMatchObject({ type: "compaction", encrypted_content: "opaque" });
  });
  test("maps hosted Responses web search calls to native Anthropic blocks", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"type":"response.created","response":{"id":"r1"}}',
      '{"type":"response.output_item.added","output_index":0,"item":{"type":"web_search_call","id":"ws_1","status":"in_progress","action":{"type":"search","query":"risuncode"}}}',
      '{"type":"response.output_item.done","output_index":0,"item":{"type":"web_search_call","id":"ws_1","status":"completed","action":{"type":"search","query":"risuncode"}}}',
      '{"type":"response.completed","response":{"status":"completed"}}',
    ]), coordinator: coord, maxLineBytes: 65536 }, createOpenAIResponsesStreamMapper()));
    expect(events).toContainEqual({
      type: "native_block_start",
      index: 0,
      block: { type: "server_tool_use", id: "ws_1", name: "web_search", input: { query: "risuncode" } },
    });
    expect(events).toContainEqual({ type: "native_block_stop", index: 0 });
  });
  test("emits native Anthropic blocks and Responses context items", async () => {
    const events: StreamEvent[] = [
      { type: "message_start", id: "m1" },
      { type: "compaction_start" },
      { type: "compaction_delta", text: "summary" },
      { type: "compaction_stop" },
      { type: "server_tool_result", block: { type: "tool_search_tool_result", tool_use_id: "srvtoolu_1", content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: "query_database" }] } } },
      { type: "message_stop", reason: "completed" },
    ];
    async function* source(): AsyncGenerator<StreamEvent, void, unknown> { for (const event of events) yield event; }
    const anthropic = new TextDecoder().decode(Buffer.concat((await collect(encodeSurfaceStream("anthropic-messages", source(), "claude"))).map((chunk) => Buffer.from(chunk))));
    expect(anthropic).toContain('"type":"compaction"');
    expect(anthropic).toContain('"type":"compaction_delta"');
    expect(anthropic).toContain('"type":"tool_search_tool_result"');
    const responseEvents: StreamEvent[] = [
      { type: "message_start", id: "r1" },
      { type: "context_item", phase: "added", outputIndex: 0, item: { type: "compaction", id: "cmp_1" } },
      { type: "context_item", phase: "done", outputIndex: 0, item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque" } },
      { type: "message_stop", reason: "completed" },
    ];
    async function* responseSource(): AsyncGenerator<StreamEvent, void, unknown> { for (const event of responseEvents) yield event; }
    const responses = new TextDecoder().decode(Buffer.concat((await collect(encodeSurfaceStream("openai-responses", responseSource(), "gpt-5.6"))).map((chunk) => Buffer.from(chunk))));
    expect(responses).toContain('"type":"response.output_item.added"');
    expect(responses).toContain('"type":"response.output_item.done"');
  });
});

describe("terminal stream error propagation", () => {
  test("converts a mid-stream provider failure into one typed terminal event", async () => {
    const observed: unknown[] = [];
    async function* source(): AsyncGenerator<StreamEvent> {
      yield { type: "message_start", id: "m1" };
      yield { type: "text_delta", text: "partial" };
      throw new Error("Bearer upstream-secret");
    }
    const events = await collect(appendTerminalError(source(), { onError: (error) => observed.push(error) }));
    expect(events).toEqual([
      { type: "message_start", id: "m1" },
      { type: "text_delta", text: "partial" },
      { type: "message_stop", reason: "error", error: { statusCode: null, kind: "provider_protocol_error", message: "Bearer [redacted]", retryAt: null } },
    ]);
    expect(observed).toHaveLength(1);
  });
});

describe("malformed and truncated streams", () => {
  test("stream without terminal event throws stream_truncated", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    expect(collect(mapSseStream({ body: sseBody(['{"choices":[{"delta":{"content":"hi"}}]}']), coordinator: coord, maxLineBytes: 65536 }, createOpenAIChatStreamMapper())).then(() => false, () => true)).resolves.toBe(true);
  });
  test("invalid JSON in SSE data throws ProviderAdapterError", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    expect(collect(mapSseStream({ body: sseBody(["not json"]), coordinator: coord, maxLineBytes: 65536 }, createOpenAIChatStreamMapper())).then(() => false, (e: unknown) => e instanceof ProviderAdapterError)).resolves.toBe(true);
  });
  test("oversized SSE line throws ProviderAdapterError", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const big = "x".repeat(100);
    expect(collect(decodeSseEvents({ body: sseBody([big]), coordinator: coord, maxLineBytes: 10 })).then(() => false, (e: unknown) => e instanceof ProviderAdapterError)).resolves.toBe(true);
  });
  test("caller abort cancels decode without hanging", async () => {
    const ac = new AbortController();
    const coord = new AbortCoordinator(ac.signal);
    const body = new ReadableStream({ start() {} });
    ac.abort();
    expect(coord.signal.aborted).toBe(true);
    const events = await collect(decodeSseEvents({ body, coordinator: coord, maxLineBytes: 65536 }));
    expect(events).toHaveLength(0);
  });
});

describe("tool call concern normalization", () => {
  test("ensureToolCallIds assigns ids to unnamed tool_use blocks", () => {
    const r = ensureToolCallIds(chatReq({ messages: [{ role: "assistant", content: [{ type: "tool_use", toolName: "f", toolArguments: "{}" }] }] }));
    expect(r.messages[0]?.content[0]?.toolCallId).toMatch(/^call_/);
  });
  test("fixMissingToolResponses adds empty tool_result for unmatched calls", () => {
    const r = fixMissingToolResponses(chatReq({ messages: [
      { role: "assistant", content: [{ type: "tool_use", toolName: "f", toolCallId: "c1", toolArguments: "{}" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] }));
    expect(r.messages.some((m) => m.role === "tool")).toBe(true);
  });
});
