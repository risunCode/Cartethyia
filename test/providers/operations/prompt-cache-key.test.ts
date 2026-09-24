import { describe, expect, test } from "bun:test";
import {
  resolveInboundSessionId,
  resolvePromptCacheKey,
} from "../../../src/providers/operations/session-resolution";
import { forwardedRequestHeaders } from "../../../src/transport/dispatch/upstream";
import {
  resolveProviderId,
  type ProviderDispatchContext,
} from "../../../src/providers/provider-registry";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "demo",
    messages: [],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  };
}

function context(request_headers: Record<string, string>): ProviderDispatchContext {
  return {
    credential: { provider_id: resolveProviderId("demo"), credential_kind: "none" },
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    request_headers,
  };
}

describe("prompt cache identity", () => {
  test("resolves the same affinity from every inbound surface", () => {
    const chat = request({
      source_surface: "chat",
      generation_controls: { "extension:prompt_cache_key": "session-a" },
    });
    const responses = request({
      source_surface: "responses",
      generation_controls: { "extension:responses.prompt_cache_key": "session-a" },
    });
    const messages = request({
      source_surface: "messages",
      generation_controls: { "extension:metadata_user_id": "session-a" },
    });
    expect(resolvePromptCacheKey(chat)).toBe("session-a");
    expect(resolvePromptCacheKey(responses)).toBe("session-a");
    expect(resolvePromptCacheKey(messages)).toBe("session-a");
  });

  test("falls back to the conversation id; client IP never enters the key", () => {
    const conversation = { conversation_id: "conv-1" };
    const fromIpA = request({ conversation, metadata: { client_ip: "203.0.113.9" } });
    const fromIpB = request({ conversation, metadata: { client_ip: "198.51.100.7" } });
    const forwardedIpA = context({
      "x-forwarded-for": "203.0.113.9",
      "x-real-ip": "203.0.113.9",
    });
    const forwardedIpB = context({
      "x-forwarded-for": "198.51.100.7",
      "x-real-ip": "198.51.100.7",
    });

    const key = resolvePromptCacheKey(fromIpA);
    expect(key).toBe("conv-1");
    // Differing only in telemetry IP must not change the resolved key, on
    // either path: metadata for the canonical resolver, and forwarded IP
    // headers for the inbound-session fallback. Fails if either source is
    // ever read into cache identity.
    expect(resolvePromptCacheKey(fromIpB)).toBe(key);
    expect(resolveInboundSessionId(forwardedIpA, fromIpA)).toBe(key);
    expect(resolveInboundSessionId(forwardedIpB, fromIpB)).toBe(key);
  });

  test("prefers an explicit cache key over the conversation id", () => {
    const keyed = request({
      conversation: { conversation_id: "conv-1" },
      generation_controls: { "extension:responses.prompt_cache_key": "explicit" },
    });
    expect(resolvePromptCacheKey(keyed)).toBe("explicit");
  });
});

describe("inbound session id header precedence", () => {
  // Mirrors SESSION_HEADERS in session-resolution.ts: first non-empty wins,
  // any session/conversation header beats session-id, and headers beat the
  // conversation-id fallback.
  const orderedHeaders = [
    "x-conversation-id",
    "x-session-id",
    "x-session-affinity",
    "x-opencode-session",
    "x-claude-code-session-id",
    "prompt_cache_key",
    "prompt-cache-key",
    "session-id",
  ] as const;

  test("honors the declared order when several session headers are present", () => {
    const requestWithConversation = request({ conversation: { conversation_id: "conv-1" } });
    // Every header from index i onward present at once: the earliest must win.
    for (let i = 0; i < orderedHeaders.length; i += 1) {
      const headers: Record<string, string> = {};
      for (const name of orderedHeaders.slice(i)) headers[name] = `value-for-${name}`;
      expect(resolveInboundSessionId(context(headers), requestWithConversation)).toBe(
        `value-for-${orderedHeaders[i]}`,
      );
    }
  });

  test("treats both prompt-cache-key spellings as equivalent and ahead of session-id", () => {
    expect(resolveInboundSessionId(context({ prompt_cache_key: "underscore" }), undefined)).toBe(
      "underscore",
    );
    expect(resolveInboundSessionId(context({ "prompt-cache-key": "hyphen" }), undefined)).toBe(
      "hyphen",
    );
    // When both spellings arrive, the underscore variant is declared first.
    expect(
      resolveInboundSessionId(
        context({ prompt_cache_key: "underscore", "prompt-cache-key": "hyphen" }),
        undefined,
      ),
    ).toBe("underscore");
    expect(
      resolveInboundSessionId(
        context({ prompt_cache_key: "underscore", "session-id": "sid" }),
        undefined,
      ),
    ).toBe("underscore");
    expect(
      resolveInboundSessionId(
        context({ "prompt-cache-key": "hyphen", "session-id": "sid" }),
        undefined,
      ),
    ).toBe("hyphen");
  });

  test("prefers any session header over the conversation id fallback", () => {
    const requestWithConversation = request({ conversation: { conversation_id: "conv-1" } });
    expect(
      resolveInboundSessionId(context({ "session-id": "sid" }), requestWithConversation),
    ).toBe("sid");
    expect(resolveInboundSessionId(context({}), requestWithConversation)).toBe("conv-1");
    expect(resolveInboundSessionId(undefined, requestWithConversation)).toBe("conv-1");
    expect(resolveInboundSessionId(context({}), request())).toBeUndefined();
  });
});

describe("forwarded request headers", () => {
  test("captures both prompt-cache-key spellings but never auth, cookies, or client IP", () => {
    const forwarded = forwardedRequestHeaders(
      new Request("https://upstream.example/v1/messages", {
        method: "POST",
        headers: {
          "prompt-cache-key": "hyphen",
          prompt_cache_key: "underscore",
          "x-session-id": "sid",
          authorization: "Bearer secret",
          cookie: "session=secret",
          "x-forwarded-for": "203.0.113.9",
          "x-real-ip": "203.0.113.9",
        },
      }),
    );
    expect(forwarded["prompt-cache-key"]).toBe("hyphen");
    expect(forwarded["prompt_cache_key"]).toBe("underscore");
    expect(forwarded["x-session-id"]).toBe("sid");
    expect(forwarded["authorization"]).toBeUndefined();
    expect(forwarded["cookie"]).toBeUndefined();
    expect(forwarded["x-forwarded-for"]).toBeUndefined();
    expect(forwarded["x-real-ip"]).toBeUndefined();
  });
});
