import { describe, expect, test } from "bun:test";
import { ChatAdapter } from "../../src/transport/surface/chat/adapter";
import { MessagesAdapter } from "../../src/transport/surface/messages/adapter";

const chat = new ChatAdapter();
const messages = new MessagesAdapter();

/** Claude Code posts block content with max_tokens to the chat endpoint. */
const claudeCodeBody = {
  model: "muse-spark-1.3",
  max_tokens: 1024,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: false,
};

describe("chat vs messages shape overlap", () => {
  test("a block-content chat body matches the chat shape", () => {
    // Regression: the matcher used to refuse block content whenever
    // max_tokens was present, so every Claude Code request logged a false
    // "ambiguous body shape" disagreement while routing correctly.
    expect(chat.matchesBodyShape(claudeCodeBody)).toBe(true);
  });

  test("the overlap resolves to no sole body signal", () => {
    // Both match a blocks+max_tokens body — genuinely ambiguous — so body
    // shape alone must not name a winner; the endpoint path decides.
    expect(messages.matchesBodyShape(claudeCodeBody)).toBe(true);
  });

  test("a plain chat body without max_tokens matches chat only", () => {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
    expect(chat.matchesBodyShape(body)).toBe(true);
    expect(messages.matchesBodyShape(body)).toBe(false);
  });

  test("a responses body matches neither", () => {
    const body = { model: "m", input: [{ role: "user", content: "hi" }] };
    expect(chat.matchesBodyShape(body)).toBe(false);
    expect(messages.matchesBodyShape(body)).toBe(false);
  });
});
