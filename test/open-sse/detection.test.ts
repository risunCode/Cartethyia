import { describe, expect, test } from "bun:test";
import { mapClientSource } from "../../src/storage/runtime/runtime";
import { clientIdentityForProfile, detectClientFormat, normalizationEndpoint } from "../../src/open-sse/translate/detection";
import { prepareProxyRequest } from "../../src/application/request/prepare";
import type { ProxyRequestDependencies } from "../../src/application/request";

describe("OpenSSE client format detection", () => {
  test("tracks explicit client headers without overriding body wire shape", () => {
    const result = detectClientFormat("/v1/chat/completions", "openai-chat", new Headers({ "x-client-name": "codex" }), {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    });

    expect(result.profile).toEqual({
      name: "codex",
      format: "cursor-chat-hybrid",
      source: "header",
      formatSource: "body-shape",
      passthrough: "same-protocol-only",
    });
    expect(result.conflicts).toEqual([]);
    expect(normalizationEndpoint("/v1/chat/completions", result)).toBe("/v1/responses");
  });

  test("tracks client identity while preserving the endpoint wire format", () => {
    const result = detectClientFormat("/v1/chat/completions", "openai-chat", new Headers({ "x-client-name": "codex" }), {
      model: "gpt-4.1",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.profile).toMatchObject({ name: "codex", format: "openai-chat", source: "header", formatSource: "endpoint" });
    expect(normalizationEndpoint("/v1/chat/completions", result)).toBe("/v1/chat/completions");
  });

  test("detects Cursor hybrid requests from user-agent and body shape", () => {
    const result = detectClientFormat("/v1/chat/completions", "openai-chat", new Headers({ "user-agent": "Cursor/1.0" }), {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "refactor" }] }],
    });

    expect(result.profile).toMatchObject({ name: "cursor", format: "cursor-chat-hybrid", source: "user-agent", formatSource: "body-shape" });
    expect(normalizationEndpoint("/v1/chat/completions", result)).toBe("/v1/responses");
  });

  test("uses body shape when endpoint is shared and no client header exists", () => {
    const result = detectClientFormat("/v1/chat/completions", "openai-chat", new Headers(), { input: "hello" });

    expect(result.profile).toEqual({
      name: "unknown",
      format: "cursor-chat-hybrid",
      source: "body-shape",
      formatSource: "body-shape",
      passthrough: "never",
    });
    expect(clientIdentityForProfile(result.profile)).toEqual({ name: "unknown", source: "body_shape" });
    expect(mapClientSource("body_shape")).toBe("body_shape");
  });

  test("falls back conservatively without exposing raw body content", () => {
    const secret = "sk-test-secret-value";
    const result = detectClientFormat("/v1/chat/completions", "openai-chat", new Headers(), {
      messages: [{ role: "user", content: secret }],
      metadata: { secret },
    });

    expect(result.profile).toEqual({
      name: "unknown",
      format: "openai-chat",
      source: "endpoint",
      formatSource: "endpoint",
      passthrough: "never",
    });
    expect(result.conflicts).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("uses the detected wire shape while preparing a Cursor hybrid request", async () => {
    const prepared = await prepareProxyRequest({
      request: {
        endpoint: "/v1/chat/completions",
        surface: "openai-chat",
        headers: new Headers({ "user-agent": "Cursor/1.0" }),
        body: { input: "refactor this", model: "gpt-4.1" },
        signal: new AbortController().signal,
      },
      authorization: { apiKeyId: null, trustedIdentity: "test" },
    }, {} as ProxyRequestDependencies);

    expect(prepared.request.sourceSurface).toBe("openai-responses");
    expect(prepared.formatDetection.profile.name).toBe("cursor");
  });
});
