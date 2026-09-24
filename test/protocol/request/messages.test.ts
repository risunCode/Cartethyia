import { describe, expect, test } from "bun:test";
import { canonicalToChatPayload } from "../../../src/protocol/request/chat";
import { canonicalToClaudeMessagesPayload } from "../../../src/protocol/request/messages";
import { canonicalToResponsesPayload } from "../../../src/protocol/request/responses";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";

const BILLING = "x-anthropic-billing-header: cc_version=2.1.257.abc; cc_entrypoint=cli; cch=00000;";

function request(): CanonicalRequest {
  return {
    model: "m",
    system: [
      { kind: "text", text: BILLING },
      { kind: "text", text: "real instruction" },
    ],
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: { max_tokens: 100 },
    stream: false,
    source_surface: "chat",
  } as CanonicalRequest;
}

describe("billing attestation is never forwarded upstream", () => {
  test("messages builder drops echoed billing blocks", () => {
    const payload = canonicalToClaudeMessagesPayload(request());
    const texts = ((payload.system ?? []) as Array<Record<string, unknown>>).map((b) => b["text"]);
    expect(texts).toEqual(["real instruction"]);
  });

  test("chat builder drops echoed billing blocks", () => {
    const payload = canonicalToChatPayload(request());
    const systems = (payload["messages"] as Array<Record<string, unknown>>).filter(
      (m) => m["role"] === "system",
    );
    expect(systems).toHaveLength(1);
    expect(systems[0]?.["content"]).toBe("real instruction");
  });

  test("responses builder drops echoed billing blocks", () => {
    const payload = canonicalToResponsesPayload(request());
    const input = payload["input"] as Array<Record<string, unknown>>;
    const texts = input.flatMap((item) =>
      ((item["content"] as Array<Record<string, unknown>>) ?? []).map((c) => c["text"]),
    );
    expect(texts).toContain("real instruction");
    expect(texts.some((t) => String(t).startsWith("x-anthropic-billing-header:"))).toBe(false);
  });
});

describe("messages streaming usage", () => {
  test("a streamed request asks the upstream for token usage", () => {
    const payload = canonicalToClaudeMessagesPayload({ ...request(), stream: true });
    expect(payload.stream_options).toEqual({ include_usage: true });
  });

  test("a non-streamed request does not send stream options", () => {
    const payload = canonicalToClaudeMessagesPayload(request());
    expect(payload.stream_options).toBeUndefined();
  });
});

function requestWithExtensions(): CanonicalRequest {
  return {
    model: "m",
    messages: [
      {
        role: "assistant",
        content: [
          { kind: "text", text: "hello" },
          // Foreign-surface annotation: no Messages representation, must not
          // reach Anthropic (unknown block types draw an upstream 400).
          {
            kind: "extension",
            name: "responses:response.output_text.annotation.added",
            payload: {
              type: "response.output_text.annotation.added",
              annotation: { type: "url_citation", url: "https://x.test" },
            },
          },
          { kind: "extension", name: "audio", payload: { data: "x" } },
          { kind: "extension", name: "unknown", payload: "x" },
          // Messages-native extensions must survive the same path.
          {
            kind: "extension",
            name: "server_tool_use",
            payload: { type: "server_tool_use", id: "srv-1" },
          },
          {
            kind: "extension",
            name: "messages:container",
            payload: { type: "container", id: "ctr-1" },
          },
        ],
      },
    ],
    generation_controls: { max_tokens: 100 },
    stream: false,
    source_surface: "responses",
  } as CanonicalRequest;
}

describe("messages builder drops foreign extensions", () => {
  test("only Messages-native extensions reach the Anthropic wire", () => {
    const payload = canonicalToClaudeMessagesPayload(requestWithExtensions());
    const blocks = (
      (payload.messages as Array<Record<string, unknown>>)[0]?.["content"] as Array<
        Record<string, unknown>
      >
    ).map((b) => b["type"]);
    expect(blocks).toContain("text");
    expect(blocks).toContain("server_tool_use");
    expect(blocks).toContain("container");
    expect(blocks.some((t) => String(t).startsWith("responses:"))).toBe(false);
    expect(blocks).not.toContain("audio");
    expect(blocks).not.toContain("unknown");
  });
});

describe("messages builder preserves cross-provider reasoning context", () => {
  test("demotes unsigned reasoning to assistant text and preserves signed Anthropic thinking", () => {
    const payload = canonicalToClaudeMessagesPayload({
      model: "claude",
      messages: [
        {
          role: "assistant",
          content: [
            { kind: "reasoning", payload: "private OpenAI reasoning", summary: "private OpenAI reasoning" },
            { kind: "reasoning", payload: "empty signature", summary: "empty signature", signature: "" },
            { kind: "reasoning", payload: "signed thinking", summary: "signed thinking", signature: "sig" },
          ],
        },
      ],
      generation_controls: { max_tokens: 100 },
      stream: false,
      source_surface: "chat",
    } as unknown as CanonicalRequest);
    const blocks = (payload.messages as Array<Record<string, unknown>>)[0]?.["content"] as Array<
      Record<string, unknown>
    >;
    expect(
      blocks.map(({ type, text, thinking, signature }) => ({
        type,
        text: text ?? null,
        thinking: thinking ?? null,
        signature: signature ?? null,
      })),
    ).toEqual([
      { type: "text", text: "private OpenAI reasoning", thinking: null, signature: null },
      { type: "text", text: "empty signature", thinking: null, signature: null },
      { type: "thinking", text: null, thinking: "signed thinking", signature: "sig" },
    ]);
  });
});

describe("messages builder hoists developer instructions", () => {
  test("top-level instructions reach payload.system, not messages[]", () => {
    const request = {
      model: "m",
      instructions: [{ kind: "text", text: "Rule 1" }],
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: { max_tokens: 10 },
      stream: false,
      source_surface: "responses",
    } as unknown as CanonicalRequest;
    const payload = canonicalToClaudeMessagesPayload(request);
    const system = (payload.system ?? []) as Array<Record<string, unknown>>;
    expect(system.map((b) => b["text"])).toContain("Rule 1");
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => m["role"])).toEqual(["user"]);
  });
});
