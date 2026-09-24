import { describe, expect, test } from "bun:test";

import {
  canContainToolResult,
  toolCallParts,
  toolResultParts,
  type CanonicalMessage,
  type CanonicalRequest,
} from "../../../src/transport/canonical-model";
import { canonicalToChatPayload } from "../../../src/protocol/request/chat";
import { canonicalToClaudeMessagesPayload } from "../../../src/protocol/request/messages";
import { convertMessages as commandCodeMessages } from "../../../src/providers/integrations/commandcode";
import { dropIncompleteToolRounds, repairRequestToolCalls } from "../../../src/transport/translation/tool-repair";

/**
 * Tool-answer placement is a canonical-model fact: results live in `tool`
 * turns **or** in `user` turns, because the Anthropic Messages ledger re-homes
 * every result into a `user` turn. Every encoder and repair pass must honor it.
 * Three separate upstream 400s came from callers re-deriving that rule with a
 * `role === "tool"` check, so it is asserted once here across the consumers.
 */
const messagesLedgerHistory: CanonicalMessage[] = [
  { role: "user", content: [{ kind: "text", text: "go" }] },
  {
    role: "assistant",
    content: [{ kind: "toolCall", call_id: "c1", name: "E", arguments: "{}", index: 0 }],
  },
  // The ledger's re-homed shape: the answer is on a USER turn.
  { role: "user", content: [{ kind: "toolResult", call_id: "c1", content: "ok" }] },
];

const request: CanonicalRequest = {
  model: "m",
  messages: messagesLedgerHistory,
  generation_controls: {},
  stream: true,
  source_surface: "messages",
};

describe("canonical tool-result placement", () => {
  test("the predicate accepts both roles that may carry a result", () => {
    expect(canContainToolResult({ role: "tool", content: [] })).toBe(true);
    expect(canContainToolResult({ role: "user", content: [] })).toBe(true);
    expect(canContainToolResult({ role: "assistant", content: [] })).toBe(false);
    expect(canContainToolResult({ role: "system", content: [] })).toBe(false);
  });

  test("extractors read parts regardless of which role carries them", () => {
    const [userTurn] = messagesLedgerHistory.slice(2);
    expect(toolResultParts(userTurn!).map((p) => p.call_id)).toEqual(["c1"]);
    expect(toolCallParts(messagesLedgerHistory[1]!).map((p) => p.call_id)).toEqual(["c1"]);
  });

  test("the chat encoder emits a user-turn result as role:tool, paired with its call", () => {
    const wire = canonicalToChatPayload(request).messages as Array<Record<string, unknown>>;
    expect(wire.map((m) => m["role"])).toEqual(["user", "assistant", "tool"]);
    expect(wire[2]?.["tool_call_id"]).toBe("c1");
    expect(wire[1]?.["tool_calls"]).toBeDefined();
  });

  test("the messages encoder keeps the result on the user turn", () => {
    const payload = canonicalToClaudeMessagesPayload(request);
    const wire = payload.messages as Array<Record<string, unknown>>;
    expect(wire.map((m) => m["role"])).toEqual(["user", "assistant", "user"]);
  });

  test("the commandcode encoder emits the user-turn result as a tool turn", () => {
    const wire = commandCodeMessages(messagesLedgerHistory).messages;
    expect(wire.map((m) => `${m["role"]}${m["tool_call_id"] ? `:${m["tool_call_id"]}` : ""}`)).toEqual([
      "user",
      "assistant",
      "tool:c1",
    ]);
  });

  test("the buddy drop policy sees the round as complete and leaves it alone", () => {
    expect(dropIncompleteToolRounds(messagesLedgerHistory)).toEqual(messagesLedgerHistory);
  });

  test("the generic repair is a structural no-op on the history", () => {
    expect(repairRequestToolCalls(request)).toBe(request);
  });
});
