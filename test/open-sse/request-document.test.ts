import { describe, expect, test } from "bun:test";
import type { ProxyRequest } from "../../src/application/contracts";
import { toRequestDocument, withFieldDisposition } from "../../src/open-sse/translate";
import { TRANSLATION_FIXTURE_LIMITS } from "./fixtures/compatibility-fixtures";

describe("canonical request document", () => {
  test("maps Cartethyia request semantics without forwarding raw wire payload", () => {
    const request: ProxyRequest = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: [{ type: "text", text: "Review this" }] }],
      tools: [],
      stream: true,
      responseFormat: "json_schema",
      reasoning: "enabled",
      reasoningConfig: { effort: "high", summary: "concise" },
      include: ["reasoning.encrypted_content"],
      contextManagement: { compact_threshold: 100_000 },
      maxOutputTokens: 4_096,
      images: [{ kind: "url", value: "https://example.com/image.png", mediaType: "image/png" }],
      sourceSurface: "anthropic-messages",
      signal: new AbortController().signal,
      limits: TRANSLATION_FIXTURE_LIMITS,
      cacheKey: "conversation-1",
      metadataUserId: "cli-user-1",
      wirePayload: { authorization: "must-not-be-forwarded" },
    };

    const document = toRequestDocument(request);

    expect(document.model).toBe("claude-sonnet-4-6");
    expect(document.messages).toBe(request.messages);
    expect(document.reasoning).toEqual({ mode: "enabled", config: { effort: "high", summary: "concise" } });
    expect(document.conversation).toEqual({ include: ["reasoning.encrypted_content"], contextManagement: { compact_threshold: 100_000 }, cacheKey: "conversation-1" });
    expect(document.media).toEqual(request.images);
    expect(document.metadata).toEqual({ userId: "cli-user-1" });
    expect(document.source).toMatchObject({ surface: "anthropic-messages", stream: true, hasWirePayload: true });
    expect(document.extensions).toEqual({});
    expect(JSON.stringify(document)).not.toContain("must-not-be-forwarded");
  });

  test("records field disposition immutably", () => {
    const request: ProxyRequest = {
      model: "gpt-4.1",
      messages: [],
      tools: [],
      stream: false,
      responseFormat: "text",
      reasoning: "default",
      maxOutputTokens: null,
      images: [],
      sourceSurface: "openai-chat",
      signal: new AbortController().signal,
      limits: TRANSLATION_FIXTURE_LIMITS,
    };
    const original = toRequestDocument(request);
    const adapted = withFieldDisposition(original, { path: "response_format.schema", action: "adapted", reason: "target surface uses response_format" });

    expect(original.dispositions).not.toContain(adapted.dispositions.at(-1));
    expect(adapted.dispositions.at(-1)).toEqual({ path: "response_format.schema", action: "adapted", reason: "target surface uses response_format" });
    expect(original.extensions).toEqual({});
  });
});
