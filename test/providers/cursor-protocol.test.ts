/**
 * The Cursor adapter speaks a hand-written slice of Cursor's agent protocol,
 * so the field numbers and the history translation have to be pinned: a wrong
 * number silently misreads a live turn, and a dropped tool result breaks the
 * caller's agent loop.
 */
import { expect, test } from "bun:test";
import { decodeMessage, encodeVarint, firstBytes, firstString } from "../../src/providers/integrations/cursor/cursor-wire";
import { decodeServerMessage, decodeUsableModels, encodeRunRequest } from "../../src/providers/integrations/cursor/cursor-messages";
import { buildTurnInput } from "../../src/providers/integrations/cursor/cursor-translate";
import { decodeArgValue, safeToolCallId } from "../../src/providers/integrations/cursor/cursor-turn";
import { exposedModelId, isExposedCursorModel, upstreamModelId } from "../../src/providers/integrations/cursor/cursor-catalog";
import type { CanonicalMessage } from "../../src/protocol/canonical-model";

test("the catalog keeps auto, grok, opus, and composer, and drops the rest", () => {
  // Ids as `GetUsableModels` returned them for a live account.
  const upstream = [
    "default",
    "gpt-5.3-codex",
    "gpt-5.2",
    "composer-2.5",
    "composer-2.5-fast",
    "claude-opus-5-thinking-high",
    "claude-opus-4-8-low",
    "claude-sonnet-5-thinking-high",
    "claude-fable-5-high",
    "cursor-grok-4.6-high",
    "grok-4.7-low",
    "gemini-3.7-flash-high",
    "kimi-k3-high",
    "glm-5.2-high",
  ];
  const kept = upstream.filter(isExposedCursorModel).map(exposedModelId);
  expect(kept).toEqual([
    "auto",
    "composer-2.5",
    "composer-2.5-fast",
    "claude-opus-5-thinking-high",
    "claude-opus-4-8-low",
    "cursor-grok-4.6-high",
    "grok-4.7-low",
  ]);
  // `auto` is the exposed name; the wire still speaks `default`.
  expect(upstreamModelId("auto")).toBe("default");
  expect(upstreamModelId("composer-2.5")).toBe("composer-2.5");
});

test("a varint wider than 28 bits round-trips", () => {
  // A blob id length and a frame length both exceed 28 bits, and the probe
  // died on exactly that with `varint too long`.
  const value = 0x8000_0000;
  const encoded = encodeVarint(value);
  expect(encoded.length).toBeGreaterThan(4);
  const key = encodeVarint((1 << 3) | 0);
  const fields = decodeMessage(concatFields(key, encoded));
  expect(fields.get(1)?.[0]).toEqual({ kind: "varint", value });
});

test("a run request carries history ids, the model, and the active user text", () => {
  const encoded = encodeRunRequest({
    rootPromptMessagesJson: [Uint8Array.of(1, 2, 3)],
    userText: "hello",
    userMessageId: "m1",
    modelId: "composer-2.5",
    conversationId: "c1",
    tools: [{ name: "get_weather", description: "weather", inputSchemaJson: "{\"type\":\"object\"}" }],
  });
  const fields = decodeMessage(encoded);
  // conversation_state is field 1, and its field 1 holds the blob ids.
  const state = decodeMessage(firstBytes(fields, 1)!);
  expect(Array.from(firstBytes(state, 1)!)).toEqual([1, 2, 3]);
  // action is field 2, user_message_action is its field 1, text is field 1.
  const action = decodeMessage(firstBytes(fields, 2)!);
  const userAction = decodeMessage(firstBytes(action, 1)!);
  const userMessage = decodeMessage(firstBytes(userAction, 1)!);
  expect(firstString(userMessage, 1)).toBe("hello");
  const model = decodeMessage(firstBytes(fields, 3)!);
  expect(firstString(model, 1)).toBe("composer-2.5");
  expect(firstString(fields, 5)).toBe("c1");
});

test("a run request emits its fields in ascending number order", () => {
  // Cursor's backend rejects an out-of-order message with `illegal tag`
  // instead of skipping the field, so the encoded order is load-bearing.
  const encoded = encodeRunRequest({
    rootPromptMessagesJson: [],
    userText: "hi",
    modelId: "composer-2.5",
    conversationId: "c1",
    tools: [{ name: "t", description: "", inputSchemaJson: "{}" }],
  });
  const numbers: number[] = [];
  let offset = 0;
  while (offset < encoded.length) {
    let key = 0;
    let shift = 0;
    while (offset < encoded.length) {
      const byte = encoded[offset]!;
      offset += 1;
      key |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    numbers.push(key >>> 3);
    const wire = key & 0x7;
    if (wire === 2) {
      let length = 0;
      shift = 0;
      while (offset < encoded.length) {
        const byte = encoded[offset]!;
        offset += 1;
        length |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      offset += length;
    }
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  expect(numbers).toEqual(sorted);
  expect(numbers).toContain(9);
});

test("a resume turn carries no user message", () => {
  const encoded = encodeRunRequest({
    rootPromptMessagesJson: [],
    modelId: "composer-2.5",
    conversationId: "c1",
    tools: [],
  });
  const action = decodeMessage(firstBytes(decodeMessage(encoded), 2)!);
  // resume_action is field 2; user_message_action (field 1) must be absent.
  expect(firstBytes(action, 1)).toBeUndefined();
  expect(firstBytes(action, 2)).toBeDefined();
});

test("server messages decode to the event the turn acts on", () => {
  // interaction_update (field 1) > text_delta (field 1) > text (field 1)
  const text = encodeNested(1, encodeNested(1, encodeStringField(1, "hi")));
  expect(decodeServerMessage(text)).toEqual({ type: "text", delta: "hi" });

  // kv_server_message (field 4) > get_blob_args (field 2) > blob_id (field 1)
  const blob = encodeNested(4, concatFields(encodeVarintField(1, 7), encodeNested(2, encodeBytesField(1, Uint8Array.of(9)))));
  const decoded = decodeServerMessage(blob);
  expect(decoded.type).toBe("get_blob");
  if (decoded.type === "get_blob") {
    expect(decoded.id).toBe(7);
    expect(Array.from(decoded.blobId)).toEqual([9]);
  }
});

test("usable models read the model id off each repeated detail", () => {
  const body = concatFields(
    encodeNested(1, encodeStringField(1, "composer-2.5")),
    encodeNested(1, encodeStringField(1, "auto")),
  );
  expect(decodeUsableModels(body).map((model) => model.modelId)).toEqual(["composer-2.5", "auto"]);
});

test("a tool argument decodes as a protobuf value, and an id is made safe", () => {
  // google.protobuf.Value string_value is field 3, length-delimited.
  const value = encodeBytesField(3, new TextEncoder().encode("Osaka"));
  expect(decodeArgValue(value)).toBe("Osaka");
  expect(safeToolCallId("call-1\nfc_2")).toBe("call-1_fc_2");
  expect(safeToolCallId("")).toMatch(/^call_/);
});

test("history keeps tool results and delivers system as a labelled exchange", () => {
  const messages: readonly CanonicalMessage[] = [
    { role: "system", content: [{ kind: "text", text: "be brief" }] },
    { role: "user", content: [{ kind: "text", text: "weather?" }] },
    { role: "assistant", content: [{ kind: "toolCall", call_id: "c1", name: "get_weather", arguments: { city: "Osaka" } }] },
    { role: "tool", content: [{ kind: "toolResult", call_id: "c1", content: "sunny" }] },
    { role: "user", content: [{ kind: "text", text: "and tomorrow?" }] },
  ];
  const input = buildTurnInput(messages, []);
  expect(input.userText).toBe("and tomorrow?");
  // system, its acknowledgement, the first user turn, the assistant tool call,
  // and the tool result. The active user message is excluded.
  expect(input.rootMessages).toHaveLength(5);
  const first = input.rootMessages[0] as { content: { text: string }[] };
  expect(first.content[0]?.text).toContain("be brief");
  const toolResult = input.rootMessages[4] as { role: string };
  expect(toolResult.role).toBe("tool");
});

test("a request ending on a tool result resumes instead of inventing a user message", () => {
  const messages: readonly CanonicalMessage[] = [
    { role: "user", content: [{ kind: "text", text: "weather?" }] },
    { role: "tool", content: [{ kind: "toolResult", call_id: "c1", content: "sunny" }] },
  ];
  const input = buildTurnInput(messages, []);
  expect(input.userText).toBeUndefined();
  expect(input.rootMessages).toHaveLength(2);
});

function encodeVarint(value: number): Uint8Array {
  const out: number[] = [];
  let rest = value >>> 0;
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  out.push(rest);
  return Uint8Array.from(out);
}

function encodeStringField(field: number, value: string): Uint8Array {
  return encodeBytesField(field, new TextEncoder().encode(value));
}

function encodeBytesField(field: number, value: Uint8Array): Uint8Array {
  return concatFields(encodeVarint((field << 3) | 2), encodeVarint(value.length), value);
}

function encodeVarintField(field: number, value: number): Uint8Array {
  return concatFields(encodeVarint((field << 3) | 0), encodeVarint(value));
}

function encodeNested(field: number, body: Uint8Array): Uint8Array {
  return encodeBytesField(field, body);
}

function concatFields(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
