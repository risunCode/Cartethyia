import { describe, expect, test } from "bun:test";
import { dropIncompleteToolRounds, repairMissingToolResponses, repairRequestToolCalls } from "../../../src/transport/translation/tool-repair";
import type { CanonicalMessage, CanonicalRequest } from "../../../src/transport/canonical-model";

function text(content: string): CanonicalMessage {
  return { role: "user", content: [{ kind: "text", text: content }] };
}

function assistantWithCalls(callIds: string[]): CanonicalMessage {
  return {
    role: "assistant",
    content: callIds.map((call_id) => ({
      kind: "toolCall" as const,
      call_id,
      name: "get_weather",
      arguments: "{}",
      index: 0,
    })),
  };
}

function toolResult(callId: string, content: string): CanonicalMessage {
  return {
    role: "tool",
    content: [{ kind: "toolResult", call_id: callId, content }],
  };
}

describe("repairMissingToolResponses", () => {
  test("inserts a synthetic result after an orphan tool call", () => {
    const history: CanonicalMessage[] = [
      text("what's the weather"),
      assistantWithCalls(["call_1"]),
      text("thanks"),
    ];
    const repaired = repairMissingToolResponses(history);
    expect(repaired).toHaveLength(4);
    expect(repaired[2]).toEqual({
      role: "tool",
      content: [{ kind: "toolResult", call_id: "call_1", content: "<missing tool output>", is_error: true }],
    });
  });

  test("leaves answered tool calls untouched", () => {
    const history: CanonicalMessage[] = [
      text("weather"),
      assistantWithCalls(["call_1"]),
      toolResult("call_1", "sunny"),
      text("thanks"),
    ];
    expect(repairMissingToolResponses(history)).toEqual(history);
  });

  test("gives each orphan in one assistant message its own synthetic result", () => {
    const history: CanonicalMessage[] = [
      text("do both"),
      assistantWithCalls(["a", "b"]),
      toolResult("b", "done"),
    ];
    const repaired = repairMissingToolResponses(history);
    expect(repaired).toHaveLength(4);
    // The synthetic result for the orphan "a" lands immediately after the
    // assistant message; the pre-existing answer for "b" keeps its position.
    const inserted = repaired[2]?.content[0];
    expect(
      inserted !== undefined && inserted.kind === "toolResult" && inserted.call_id === "a",
    ).toBe(true);
    const answered = repaired[3]?.content[0];
    expect(
      answered !== undefined && answered.kind === "toolResult" && answered.call_id === "b",
    ).toBe(true);
  });

  test("matches results by call_id, not by message position", () => {
    const history: CanonicalMessage[] = [
      text("q"),
      assistantWithCalls(["x", "y"]),
      toolResult("x", "one"),
      toolResult("y", "two"),
    ];
    expect(repairMissingToolResponses(history)).toEqual(history);
  });

  test("does not treat Anthropic role:user tool results as orphans", () => {
    // The Anthropic Messages tool ledger re-homes tool results into
    // `role: "user"` messages. The repair must match by content part, not
    // message role — otherwise every answered Anthropic tool_use gets a
    // spurious synthetic `<missing tool output>` result injected.
    const callId = "call_01a08707e38f7bd0921843980e27bb9f";
    const history: CanonicalMessage[] = [
      text("write a txt to desktop"),
      {
        role: "assistant",
        content: [
          {
            kind: "toolCall",
            call_id: callId,
            name: "write_file",
            arguments: "{}",
            index: 0,
          },
        ],
      },
      {
        role: "user",
        content: [{ kind: "toolResult", call_id: callId, content: "written" }],
      },
    ];
    expect(repairMissingToolResponses(history)).toEqual(history);
  });

  test("empty history stays empty", () => {
    expect(repairMissingToolResponses([])).toEqual([]);
  });

  test("orphan tool call gets a non-empty result (Anthropic regression)", () => {
    const callId = "call_01a0OrphanToolCallExample";
    const history: CanonicalMessage[] = [
      text("what's the weather"),
      {
        role: "assistant",
        content: [
          {
            kind: "toolCall",
            call_id: callId,
            name: "get_weather",
            arguments: "{}",
            index: 0,
          },
        ],
      },
    ];
    const repaired = repairMissingToolResponses(history);
    expect(repaired).toHaveLength(3);
    const inserted = repaired[2]!;
    expect(inserted).toEqual({
      role: "tool",
      content: [{ kind: "toolResult", call_id: callId, content: "<missing tool output>", is_error: true }],
    });
    const content = inserted.content[0]!;
    expect(content).toBeDefined();
    expect(content.kind === "toolResult" ? content.content : "").toBeTruthy();
  });
});

describe("orphan tool results and interleaved batches", () => {
  const user = (text: string): CanonicalMessage => ({
    role: "user",
    content: [{ kind: "text", text }],
  });
  const parallelCalls = (ids: readonly string[]): CanonicalMessage => ({
    role: "assistant",
    content: ids.map((id) => ({ kind: "toolCall" as const, call_id: id, name: "f", arguments: {} })),
  });
  const result = (id: string): CanonicalMessage => ({
    role: "tool",
    content: [{ kind: "toolResult", call_id: id, content: "ok", is_error: false }],
  });
  const notice = (text: string): CanonicalMessage => ({
    role: "developer",
    content: [{ kind: "text", text }],
  });
  const request = (messages: readonly CanonicalMessage[]): CanonicalRequest => ({
    model: "m",
    messages: [...messages],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  });

  /**
   * WorkBuddy/CodeBuddy answer a broken tool history with HTTP 400
   * `11148 tool_call_sequence_broken`, and the client replays the same broken
   * history on every later turn — so one bad round kills the conversation.
   * These cover the two shapes `repairMissingToolResponses` does not: an
   * orphan result (no call anywhere) and results split by an interleaved turn.
   */
  test("drops a tool result whose call is missing from the whole history", () => {
    const repaired = repairRequestToolCalls(request([user("hi"), result("gone")]));
    expect(repaired.messages.some((m) => m.content.some((p) => p.kind === "toolResult" && p.call_id === "gone"))).toBe(false);
    // The user turn survives: only the unanswerable result is removed.
    expect(repaired.messages.some((m) => m.role === "user")).toBe(true);
  });

  test("keeps a result whose call is present", () => {
    const repaired = repairRequestToolCalls(
      request([user("hi"), parallelCalls(["c1"]), result("c1")]),
    );
    expect(repaired.messages.some((m) => m.content.some((p) => p.kind === "toolResult" && p.call_id === "c1"))).toBe(true);
  });

  test("moves an interleaved turn after the whole batch of results", () => {
    // Codex's `image_resize_notice` lands between two parallel results.
    const repaired = repairRequestToolCalls(
      request([user("go"), parallelCalls(["c1", "c2"]), result("c1"), notice("<notice>"), result("c2")]),
    );
    const roles = repaired.messages.map((m) =>
      m.role === "tool" ? `tool:${(m.content[0] as { call_id: string }).call_id}` : m.role,
    );
    expect(roles).toEqual(["user", "assistant", "tool:c1", "tool:c2", "developer"]);
  });

  test("returns the same request object for a compliant history", () => {
    // No copy, no allocation: the repair is a structural no-op when the
    // history is already valid, and that identity is what callers rely on.
    const clean = request([user("go"), parallelCalls(["c1"]), result("c1")]);
    expect(repairRequestToolCalls(clean)).toBe(clean);
  });

  test("repairs an orphan call and an orphan result in one pass", () => {
    const repaired = repairRequestToolCalls(
      request([user("go"), parallelCalls(["c-lost"]), result("c-orphan")]),
    );
    // The orphan result is gone, and the unanswered call got a synthesized one.
    const resultIds = repaired.messages.flatMap((m) =>
      m.content.filter((p) => p.kind === "toolResult").map((p) => (p as { call_id: string }).call_id),
    );
    expect(resultIds).not.toContain("c-orphan");
    expect(resultIds).toContain("c-lost");
  });
});

describe("symmetric pairing (11148 regression)", () => {
  const user = (text: string): CanonicalMessage => ({
    role: "user",
    content: [{ kind: "text", text }],
  });
  const calls = (ids: readonly string[]): CanonicalMessage => ({
    role: "assistant",
    content: ids.map((call_id) => ({
      kind: "toolCall" as const,
      call_id,
      name: "f",
      arguments: "{}",
      index: 0,
    })),
  });
  const result = (id: string): CanonicalMessage => ({
    role: "tool",
    content: [{ kind: "toolResult", call_id: id, content: "ok" }],
  });
  const request = (messages: readonly CanonicalMessage[]): CanonicalRequest => ({
    model: "m",
    messages: [...messages],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  });
  const pairShape = (messages: readonly CanonicalMessage[]): string =>
    messages
      .map((m) =>
        `${m.role}[${m.content
          .map((p) => (p.kind === "toolCall" || p.kind === "toolResult" ? `${p.kind}:${(p as { call_id: string }).call_id}` : p.kind))
          .join(",")}]`,
      )
      .join(" | ");
  const assertSymmetric = (messages: readonly CanonicalMessage[]): void => {
    const callIds = new Set<string>();
    for (const m of messages)
      for (const p of m.content) if (p.kind === "toolCall") callIds.add((p as { call_id: string }).call_id);
    const resultIds = new Set<string>();
    for (const m of messages)
      for (const p of m.content) if (p.kind === "toolResult") resultIds.add((p as { call_id: string }).call_id);
    for (const id of callIds) expect(resultIds.has(id)).toBe(true);
    for (const id of resultIds) expect(callIds.has(id)).toBe(true);
  };

  test("partial batch synthesizes only the unanswered call, in call order", () => {
    // assistant[c1 c2] + tool[c1]: c2 gets a synthetic result placed
    // immediately after the assistant turn, so the wire reads
    // assistant -> tool[c2-synth] -> tool[c1-real], matching call order.
    const repaired = repairRequestToolCalls(request([user("go"), calls(["c1", "c2"]), result("c1")]));
    expect(pairShape(repaired.messages)).toBe(
      "user[text] | assistant[toolCall:c1,toolCall:c2] | tool[toolResult:c2] | tool[toolResult:c1]",
    );
    assertSymmetric(repaired.messages);
  });

  test("result arriving before its call does not satisfy it", () => {
    // A stale replay (tool[c9] before assistant[c9]) keeps the result AND
    // synthesizes the missing answer after the call, so the call is never
    // left dangling on the wire.
    const repaired = repairRequestToolCalls(
      request([user("go"), result("c9"), calls(["c9"])]),
    );
    expect(pairShape(repaired.messages)).toBe(
      "user[text] | tool[toolResult:c9] | assistant[toolCall:c9] | tool[toolResult:c9]",
    );
  });

  test("every repaired history is symmetric: no dangling call, no orphan result", () => {
    const histories: CanonicalMessage[][] = [
      [user("go"), calls(["c1", "c2"]), result("c1")],
      [user("go"), calls(["c1", "c2"]), result("c1"), user("next")],
      [user("go"), calls(["c1", "c2"]), result("c1"), result("c2")],
      [user("go"), calls(["c1"]), calls(["c2"])],
      [user("go"), calls(["c1"]), result("c1"), calls(["d1", "d2"]), result("d1"), user("next")],
    ];
    for (const h of histories) {
      const repaired = repairRequestToolCalls(request(h));
      assertSymmetric(repaired.messages);
    }
  });
});

describe("dropIncompleteToolRounds", () => {
  test("drops a partial batch: calls stripped, dangling results go with it", () => {
    const messages = [text("go"), assistantWithCalls(["c1", "c2"]), toolResult("c1", "one")];
    const dropped = dropIncompleteToolRounds(messages);
    expect(dropped).toEqual([text("go")]);
  });

  test("keeps a complete round byte-for-byte", () => {
    const complete = [
      text("go"),
      assistantWithCalls(["c1", "c2"]),
      toolResult("c1", "one"),
      toolResult("c2", "two"),
    ];
    expect(dropIncompleteToolRounds(complete)).toEqual(complete);
  });

  test("keeps an assistant turn's surviving text when its calls are stripped", () => {
    const withText: CanonicalMessage = {
      role: "assistant",
      content: [
        { kind: "text", text: "working on it" },
        { kind: "toolCall", call_id: "c1", name: "get_weather", arguments: "{}", index: 0 },
      ],
    };
    const dropped = dropIncompleteToolRounds([text("go"), withText, toolResult("other", "x")]);
    expect(dropped).toEqual([
      text("go"),
      { role: "assistant", content: [{ kind: "text", text: "working on it" }] },
      toolResult("other", "x"),
    ]);
  });

  test("leaves a trailing batch with no results yet for the synthesis pass", () => {
    const trailing = [text("go"), assistantWithCalls(["c1"])];
    expect(dropIncompleteToolRounds(trailing)).toEqual(trailing);
  });

  test("keeps a complete round whose results live in USER turns", () => {
    // The Messages ledger re-homes every Anthropic tool flow into `user`
    // turns. A `role: "tool"`-only scan read the round as incomplete, stripped
    // the tool calls, and left the dangling result — a broken sequence the
    // buddy gateway rejects (`11148`), and the reasoning-content 400 followed
    // from the same damage.
    const history: CanonicalMessage[] = [
      text("go"),
      assistantWithCalls(["c1", "c2"]),
      { role: "user", content: [{ kind: "toolResult", call_id: "c1", content: "one" }] },
      { role: "user", content: [{ kind: "toolResult", call_id: "c2", content: "two" }] },
    ];
    expect(dropIncompleteToolRounds(history)).toEqual(history);
  });

  test("still drops a partial round whose results live in USER turns", () => {
    const history: CanonicalMessage[] = [
      text("go"),
      assistantWithCalls(["c1", "c2"]),
      { role: "user", content: [{ kind: "toolResult", call_id: "c1", content: "one" }] },
    ];
    expect(dropIncompleteToolRounds(history)).toEqual([text("go")]);
  });
});

describe("buddy policy vs generic synthesis ordering (11148 regression)", () => {
  const request = (messages: readonly CanonicalMessage[]): CanonicalRequest => ({
    model: "m",
    messages: [...messages],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  });
  const pairShape = (messages: readonly CanonicalMessage[]): string =>
    messages
      .map(
        (m) =>
          `${m.role}[${m.content
            .map((p) =>
              p.kind === "toolCall" || p.kind === "toolResult"
                ? `${p.kind}:${p.call_id}`
                : p.kind,
            )
            .join(",")}]`,
      )
      .join(" | ");
  const userResult = (callId: string, content: string): CanonicalMessage => ({
    role: "user",
    content: [{ kind: "toolResult", call_id: callId, content }],
  });

  test("an orphan tool result inside a USER turn is dropped", () => {
    // The Messages ledger re-homes Anthropic tool results into `user` turns,
    // so an orphan there survived a `role === "tool"`-only scan and was then
    // emitted as an unpaired `role:"tool"` message — the upstream 400
    // "tool calls and tool results do not match".
    const history: CanonicalMessage[] = [
      text("go"),
      assistantWithCalls(["c1"]),
      userResult("ghost", "x"),
    ];
    const repaired = repairRequestToolCalls(request(history));
    expect(pairShape(repaired.messages)).toBe("user[text] | assistant[toolCall:c1] | tool[toolResult:c1]");
  });

  test("a user turn holding only an orphan result is removed entirely", () => {
    const history: CanonicalMessage[] = [
      text("go"),
      assistantWithCalls(["c1"]),
      toolResult("c1", "ok"),
      userResult("ghost", "x"),
    ];
    const repaired = repairRequestToolCalls(request(history));
    expect(repaired.messages.some((m) => m.role === "user" && m.content.some((p) => p.kind === "toolResult"))).toBe(
      false,
    );
  });

  test("buddy policy must run BEFORE synthesis or the partial batch is fabricated complete", () => {
    // Regression for the dispatch order in `preparer.ts`. Repairing first
    // synthesizes a `<missing tool output>` result for c2, so the batch looks
    // complete and `dropIncompleteToolRounds` becomes a no-op — dispatching
    // exactly the `assistant[c1 c2] + tool[c1]` shape the buddy gateway
    // rejects. Dropping first removes the whole partial round.
    const partial: CanonicalMessage[] = [
      text("go"),
      assistantWithCalls(["c1", "c2"]),
      toolResult("c1", "one"),
    ];
    const wrongOrder = dropIncompleteToolRounds(repairRequestToolCalls(request(partial)).messages);
    expect(wrongOrder.some((m) => m.role === "tool" && m.content.some((p) => p.kind === "toolResult" && p.call_id === "c2"))).toBe(
      true,
    );
    const rightOrder = repairRequestToolCalls({
      ...request(partial),
      messages: dropIncompleteToolRounds(partial),
    }).messages;
    expect(pairShape(rightOrder)).toBe("user[text]");
  });
});
