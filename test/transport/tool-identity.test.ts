import { describe, expect, test } from "bun:test";
import { createToolCallTracker, resetToolCallTracker, trackToolCall, createToolEmitLedger, toolIdentityKey } from "../../src/transport/tool-identity";

describe("trackToolCall argument accumulation", () => {
  test("joins fragments from many deltas", () => {
    const tracker = createToolCallTracker();
    let state = trackToolCall(tracker, { id: "call-1", name: "lookup", args: '{"q":' }).state;
    state = trackToolCall(tracker, { id: "call-1", args: '"x"' }).state;
    state = trackToolCall(tracker, { id: "call-1", args: "}" }).state;
    expect(state.arguments).toBe('{"q":"x"}');
    expect(state.name).toBe("lookup");
  });

  test("reset clears accumulated arguments", () => {
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "call-1", args: "abc" });
    resetToolCallTracker(tracker);
    const state = trackToolCall(tracker, { id: "call-1", args: "d" }).state;
    expect(state.arguments).toBe("d");
  });

  test("many small deltas accumulate in linear time", () => {
    const tracker = createToolCallTracker();
    const deltas = 30_000;
    const fragment = "x".repeat(200);
    const started = Date.now();
    let state = trackToolCall(tracker, { id: "call-1", args: fragment }).state;
    for (let i = 1; i < deltas; i++) {
      state = trackToolCall(tracker, { id: "call-1", args: fragment }).state;
    }
    expect(state.arguments).toHaveLength(deltas * fragment.length);
    // Quadratic prefix re-copying would take minutes here; chunked
    // accumulation plus one join must stay comfortably under the bound.
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe("toolIdentityKey", () => {
  test("collapses the call_/fc_ prefix variants of one call", () => {
    expect(toolIdentityKey("call_abc123")).toBe(toolIdentityKey("fc_abc123"));
    expect(toolIdentityKey("call_abc123")).not.toBe(toolIdentityKey("call_other"));
  });
});

describe("createToolEmitLedger", () => {
  test("a prefix variant of a claimed call is not claimed twice", () => {
    const ledger = createToolEmitLedger();
    expect(ledger.claimFirstEmission("call_abc123", "Write", '{"a":1}')).toBe(true);
    expect(ledger.claimFirstEmission("fc_abc123", "Write", '{"a":1}')).toBe(false);
  });

  test("an unknown-prefix duplicate is caught by name + arguments", () => {
    const ledger = createToolEmitLedger();
    expect(ledger.claimFirstEmission("tool_abc", "Write", '{"a":1}')).toBe(true);
    expect(ledger.isDuplicateDefinition("xyz_abc", "Write", '{"a":1}')).toBe(true);
    expect(ledger.isDuplicateDefinition("xyz_abc", "Read", '{"a":1}')).toBe(false);
  });

  test("a same-id continuation is never a duplicate", () => {
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("call-a", "get_weather", "");
    expect(ledger.isDuplicateDefinition("call-a", "get_weather", '{"c":1}')).toBe(false);
  });

  test("empty arguments never count as evidence of duplication", () => {
    // Two parallel calls to the same tool both start at `arguments: ""`. That
    // is not identity: collapsing them drops the second call's name, and the
    // client then replays `name: ""` upstream (the Muse
    // "`name` must be non-empty" failure).
    const ledger = createToolEmitLedger();
    expect(ledger.claimFirstEmission("chatcmpl-tool-aaa", "Glob", "")).toBe(true);
    expect(ledger.isDuplicateDefinition("chatcmpl-tool-bbb", "Glob", "")).toBe(false);
    // Whitespace-only arguments are equally uninformative.
    expect(ledger.isDuplicateDefinition("chatcmpl-tool-ccc", "Glob", "  ")).toBe(false);
  });

  test("substantive identical arguments still collapse across ids", () => {
    // The rule is narrowed, not deleted: a repeated *complete* definition is
    // still a duplicate delivery.
    const ledger = createToolEmitLedger();
    expect(ledger.claimFirstEmission("tool_abc", "Write", '{"a":1}')).toBe(true);
    expect(ledger.isDuplicateDefinition("xyz_abc", "Write", '{"a":1}')).toBe(true);
    expect(ledger.isDuplicateDefinition("xyz_abc", "Read", '{"a":1}')).toBe(false);
  });

  test("known call_/fc_ spellings stay exempt from the fallback", () => {
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("call_abc", "Glob", '{"a":1}');
    expect(ledger.isDuplicateDefinition("fc_abc", "Glob", '{"a":1}')).toBe(false);
  });

  test("hasStreamedArguments flips only after markStreamedArguments", () => {
    const ledger = createToolEmitLedger();
    expect(ledger.hasStreamedArguments("call-1")).toBe(false);
    ledger.markStreamedArguments("call-1");
    expect(ledger.hasStreamedArguments("call-1")).toBe(true);
  });

  test("nextOrphanId is distinct on every call", () => {
    const ledger = createToolEmitLedger();
    expect(ledger.nextOrphanId("call")).not.toBe(ledger.nextOrphanId("call"));
  });

  test("reset forgets every claim", () => {
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("call_abc", "Write", "{}");
    ledger.reset();
    expect(ledger.claimFirstEmission("call_abc", "Write", "{}")).toBe(true);
  });
});
