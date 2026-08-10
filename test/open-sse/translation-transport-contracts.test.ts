import { describe, expect, test } from "bun:test";
import type { ProxyRequest, RequestLimits, StreamEvent } from "../../src/application/contracts";
import {
  normalizeChatRequest, normalizeMessagesRequest, normalizeResponsesRequest,
  buildChatPayload, buildMessagesPayload, buildResponsesPayload,
  mapChatUsage, mapAnthropicUsage, mapResponsesUsage,
  resolveWireSurface, parseRequestBody, lookupProxyEndpoint, toOpenAIImageUrl,
} from "../../src/open-sse/translate";
import { ProtocolCodecError, StreamDecodeError } from "../../src/open-sse/translate/errors";
import { ProviderAdapterError, parseRetryAfterSeconds, toProviderCallError } from "../../src/open-sse/transport/errors";
import { AbortCoordinator } from "../../src/open-sse/transport/abort-coordinator";
import { parseSseData, decodeSseEvents } from "../../src/open-sse/transport/sse-decoder";
import { mapSseStream } from "../../src/open-sse/transport/stream-mapper";
import { capabilitiesOf } from "../../src/open-sse/transport/catalog";
import { encodeSurfaceStream } from "../../src/providers/surfaces";
import { createOpenAIChatStreamMapper, createOpenAIResponsesStreamMapper } from "../../src/open-sse/transport/protocols/openai";
import { createAnthropicMessagesStreamMapper } from "../../src/open-sse/transport/protocols/anthropic";
import { ensureToolCallIds, fixMissingToolResponses } from "../../src/open-sse/concerns/tool-calls";
import type { NormalizeInput } from "../../src/application/protocols";
import { isProtocolError } from "../../src/application/protocols";
import { OpenAIAdapter } from "../../src/providers/openai";
import { CodexAdapter } from "../../src/providers/codex";

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
      const result = await adapter.call({ target: adapter.resolveTarget("gpt-5.4", "openai-responses"), request: chatReq({ model: "codex/gpt-5.4" }), credential, network: { proxyId: null, url: null, release: async () => {} }, signal: new AbortController().signal });
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
  test("thinking blocks excluded from content but force reasoning; tool_use/tool_result normalized", () => {
    const r = normalizeMessagesRequest({ model: "c", max_tokens: 1024, messages: [{ role: "user", content: [{ type: "thinking", thinking: "p" }, { type: "text", text: "q" }] }] }, ni());
    expect(r.ok).toBe(true); if (!r.ok) return; expect(r.request.reasoning).toBe("enabled"); expect(r.request.messages[0]?.content).toHaveLength(1);
    const r2 = normalizeMessagesRequest({ model: "c", max_tokens: 1024, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "s", input: { q: "x" } }] }] }, ni());
    expect(r2.ok).toBe(true); if (!r2.ok) return; expect(r2.request.messages[0]?.content[0]?.toolArguments).toBe(JSON.stringify({ q: "x" }));
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
  test("preserves Claude web search natively and exposes a function schema to other providers", () => {
    const r = normalizeMessagesRequest({
      model: "c",
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: "search" }],
    }, ni());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.tools[0]?.nativeType).toBe("web_search_20250305");
    expect(r.request.tools[0]?.inputSchema.required).toEqual(["query"]);
    const payload = buildMessagesPayload(r.request, capabilitiesOf({ surfaces: ["anthropic-messages"], reasoning: true }));
    expect(payload.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
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
    expect(r.request.tools).toHaveLength(0);
  });
  test("keeps Claude server-tool blocks in continuation context", () => {
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
    expect(r.request.messages[0]?.content[0]?.type).toBe("text");
    expect(r.request.messages[0]?.content[0]?.text).toContain("web_search");
    expect(r.request.messages[0]?.content[1]?.text).toContain("Risun");
  });
  test("payload: thinking capped at 32000; invalid JSON tool args throws; cache control applied", () => {
    const caps = capabilitiesOf({ surfaces: ["anthropic-messages"], reasoning: true, explicitCache: true, promptCacheKey: true });
    expect(buildMessagesPayload(chatReq({ sourceSurface: "anthropic-messages", reasoning: "enabled", maxOutputTokens: 100000 }), caps).thinking).toEqual({ type: "enabled", budget_tokens: 32000 });
    expect(() => buildMessagesPayload(chatReq({ sourceSurface: "anthropic-messages", messages: [{ role: "assistant", content: [{ type: "tool_use", toolName: "s", toolCallId: "t1", toolArguments: "bad" }] }] }), caps)).toThrow(ProtocolCodecError);
    const p = buildMessagesPayload(chatReq({ sourceSurface: "anthropic-messages", cacheKey: "ck", messages: [{ role: "system", content: [{ type: "text", text: "s" }] }, { role: "user", content: [{ type: "text", text: "u" }] }] }), caps);
    expect(Array.isArray(p.system)).toBe(true);
  });
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
  expect(input[1]).toEqual({ role: "user", content: "continue" });
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
  test("reasoning blocks excluded; refusal never visible; payload defaults to concise summaries", () => {
    const r = normalizeResponsesRequest({ model: "o1", input: [{ type: "message", role: "user", content: [{ type: "reasoning" }, { type: "input_text", text: "real" }] }] }, ni());
    expect(r.ok).toBe(true); if (!r.ok) return; expect(r.request.reasoning).toBe("enabled"); expect(r.request.messages[0]?.content).toHaveLength(1);
    const r2 = normalizeResponsesRequest({ model: "o1", input: [{ type: "message", role: "assistant", content: [{ type: "refusal" }] }] }, ni());
    expect(r2.ok).toBe(true); if (!r2.ok) return; expect(r2.request.messages[0]?.content[0]?.type).toBe("unknown");
    expect(buildResponsesPayload(chatReq({ sourceSurface: "openai-responses", reasoning: "enabled" })).reasoning).toEqual({ effort: "medium", summary: "concise" });
  });
});

describe("usage mapping", () => {
  test("chat: maps tokens, computes total, surfaces cache and reasoning", () => {
    expect(mapChatUsage({ prompt_tokens: 5, completion_tokens: 7 }).totalTokens).toBe(12);
    expect(mapChatUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8 }, completion_tokens_details: { reasoning_tokens: 3 } }).cacheReadTokens).toBe(8);
    expect(mapChatUsage({ prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } }).reasoningTokens).toBe(3);
  });
  test("anthropic: maps tokens, surfaces cache read/write", () => {
    const u = mapAnthropicUsage({ input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 });
    expect(u.totalTokens).toBe(8); expect(u.cacheReadTokens).toBe(100); expect(u.cacheWriteTokens).toBe(50);
  });
  test("responses: maps tokens, surfaces cache and reasoning", () => {
    expect(mapResponsesUsage({ input_tokens: 5, output_tokens: 7 }).totalTokens).toBe(12);
    expect(mapResponsesUsage({ input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 3 } }).cacheReadTokens).toBe(8);
    expect(mapResponsesUsage({ input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } }).reasoningTokens).toBe(3);
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
  test("response.failed emits error stop reason", async () => {
    const coord = new AbortCoordinator(new AbortController().signal);
    const events = await collect(mapSseStream({ body: sseBody([
      '{"type":"response.failed"}',
    ]), coordinator: coord, maxLineBytes: 65536 }, createOpenAIResponsesStreamMapper()));
    const stop = events.find((e): e is Extract<StreamEvent, { type: "message_stop" }> => e.type === "message_stop");
    expect(stop?.reason).toBe("error");
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
  test("emits native Anthropic blocks and Responses context items", async () => {
    const events: StreamEvent[] = [
      { type: "message_start", id: "m1" },
      { type: "compaction_start" },
      { type: "compaction_delta", text: "summary" },
      { type: "compaction_stop" },
      { type: "message_stop", reason: "completed" },
    ];
    async function* source(): AsyncGenerator<StreamEvent, void, unknown> { for (const event of events) yield event; }
    const anthropic = new TextDecoder().decode(Buffer.concat((await collect(encodeSurfaceStream("anthropic-messages", source(), "claude"))).map((chunk) => Buffer.from(chunk))));
    expect(anthropic).toContain('"type":"compaction"');
    expect(anthropic).toContain('"type":"compaction_delta"');
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
