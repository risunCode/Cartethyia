/**
 * Tool-call identity, accumulation, and de-duplication.
 *
 * Two modules share this file because they answer one question between them:
 * *which logical tool call is this frame talking about?*
 *
 * - `createToolCallTracker` accumulates streamed `arguments` fragments and pins
 *   a stable index per call id.
 * - `createToolEmitLedger` decides whether a call-defining frame is emitted
 *   once, twice, or not at all.
 *
 * Both sit on the path that turns a provider's SSE deltas into the client's
 * tool calls, and both fail *silently*: a dropped index or a wrongly-collapsed
 * duplicate does not error, it produces an agent that calls the wrong tool or
 * calls one twice. So the cases below are the awkward ones — a call whose first
 * frame carries no name, two parallel calls to the same tool, one call
 * delivered under two provider prefixes — rather than the happy path.
 *
 * The `arguments` accumulation is deliberately O(N) (a chunk array joined on
 * read, not a re-copied prefix), so the tests assert the *joined value* and the
 * `isFirst` boundary rather than any internal representation.
 */
import { describe, expect, test } from "bun:test";
import {
  createToolCallTracker,
  createToolEmitLedger,
  resetToolCallTracker,
  toolIdentityKey,
  type ToolCallTracker,
  trackToolCall,
} from "../../src/transport/tool-identity";

/** The joined arguments of a call, or `undefined` when it is untracked. */
function argsOf(tracker: ToolCallTracker, id: string): string | undefined {
  return tracker.states.get(id)?.arguments;
}

describe("toolIdentityKey", () => {
  test("a `call_` prefix is stripped", () => {
    // The Codex/Responses spelling. Both ids must resolve to one logical call so
    // an agent does not perform the same action twice.
    expect(toolIdentityKey("call_abc123")).toBe("abc123");
  });

  test("an `fc_` prefix is stripped", () => {
    // The alternate spelling some backends use for the same call.
    expect(toolIdentityKey("fc_abc123")).toBe("abc123");
  });

  test("the two spellings of one call collapse to the same key", () => {
    // This equality is the entire purpose of the function.
    expect(toolIdentityKey("call_abc123")).toBe(toolIdentityKey("fc_abc123"));
  });

  test("only the FIRST prefix is stripped", () => {
    // The pattern is anchored with `^` and not global, so a nested-looking id
    // keeps its inner prefix. Pinned: a global replace would over-collapse.
    expect(toolIdentityKey("call_fc_abc")).toBe("fc_abc");
  });

  test("an unprefixed id is unchanged", () => {
    expect(toolIdentityKey("abc123")).toBe("abc123");
    expect(toolIdentityKey("")).toBe("");
  });

  test("a prefix appearing later in the id is not touched", () => {
    // `replace` with `^` — a call id that merely contains "call_" mid-string is
    // a different provider's format and must not be rewritten.
    expect(toolIdentityKey("msg_call_abc")).toBe("msg_call_abc");
    expect(toolIdentityKey("xcall_abc")).toBe("xcall_abc");
  });

  test("the prefix match is case-sensitive", () => {
    // `CALL_` is not the documented spelling; treating it as one would collapse
    // ids the gateway has no evidence are the same call.
    expect(toolIdentityKey("CALL_abc")).toBe("CALL_abc");
  });

  test("a bare prefix with nothing after it becomes an empty key", () => {
    // Degenerate but reachable from a malformed frame; pinned so the boundary is
    // known rather than surprising. An empty key is shared by `call_` and `fc_`.
    expect(toolIdentityKey("call_")).toBe("");
    expect(toolIdentityKey("fc_")).toBe("");
    expect(toolIdentityKey("call_")).toBe(toolIdentityKey("fc_"));
  });
});

describe("createToolCallTracker / resetToolCallTracker", () => {
  test("a fresh tracker is empty and starts at index zero", () => {
    const tracker = createToolCallTracker();
    expect(tracker.nextIndex).toBe(0);
    expect(tracker.indexById.size).toBe(0);
    expect(tracker.states.size).toBe(0);
  });

  test("reset clears the calls and the index counter", () => {
    // Per-turn reset: a second turn must not inherit the first turn's indexes,
    // or the client sees tool call indexes that continue from a previous
    // response.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", name: "search", args: "{}" });
    trackToolCall(tracker, { id: "b", name: "read", args: "{}" });
    expect(tracker.nextIndex).toBe(2);

    resetToolCallTracker(tracker);
    expect(tracker.nextIndex).toBe(0);
    expect(tracker.indexById.size).toBe(0);
    expect(tracker.states.size).toBe(0);

    // And the next call is index 0 again.
    expect(trackToolCall(tracker, { id: "c", name: "search" }).index).toBe(0);
  });

  test("reset is idempotent", () => {
    const tracker = createToolCallTracker();
    resetToolCallTracker(tracker);
    resetToolCallTracker(tracker);
    expect(tracker.nextIndex).toBe(0);
  });
});

describe("trackToolCall — index assignment", () => {
  test("the first call takes index 0 and is marked first", () => {
    const tracker = createToolCallTracker();
    const result = trackToolCall(tracker, { id: "a", name: "search", args: "{}" });
    expect(result.index).toBe(0);
    expect(result.isFirst).toBe(true);
  });

  test("sequential calls take increasing indexes", () => {
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a" });
    trackToolCall(tracker, { id: "b" });
    expect(trackToolCall(tracker, { id: "c" }).index).toBe(2);
  });

  test("a repeat of a known id keeps its pinned index and is not first", () => {
    // The property that makes streaming work: the terminal frame of a call must
    // land on the same index as its opening frame, or the client sees two calls.
    const tracker = createToolCallTracker();
    const first = trackToolCall(tracker, { id: "a", name: "search", args: '{"q":' });
    const second = trackToolCall(tracker, { id: "a", args: '"x"}' });
    expect(second.index).toBe(first.index);
    expect(second.isFirst).toBe(false);
  });

  test("an explicit wire index wins over the counter", () => {
    // The chat surface sends explicit indexes; honoring them is what keeps the
    // client's own array positions aligned.
    const tracker = createToolCallTracker();
    const result = trackToolCall(tracker, { id: "a", index: 7 });
    expect(result.index).toBe(7);
    expect(tracker.indexById.get("a")).toBe(7);
  });

  test("the counter advances past an explicit high index", () => {
    // `nextIndex = Math.max(nextIndex, index + 1)` — otherwise a later
    // auto-indexed call would collide with the explicit one.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", index: 7 });
    expect(tracker.nextIndex).toBe(8);
    expect(trackToolCall(tracker, { id: "b" }).index).toBe(8);
  });

  test("the counter does NOT move backwards for a low explicit index", () => {
    // `Math.max` — a provider that reuses index 0 must not rewind the counter
    // and hand the same index to two calls.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", index: 5 });
    trackToolCall(tracker, { id: "b", index: 0 });
    expect(tracker.nextIndex).toBe(6);
    expect(trackToolCall(tracker, { id: "c" }).index).toBe(6);
  });

  test("an explicit index is ignored for a known id in favour of the pinned one", () => {
    // MEASURED: the precedence is `explicit > pinned > fallback > counter`, so
    // an explicit index DOES win even for a known id. This is deliberate — the
    // wire index is authoritative when present — and it means a provider that
    // sends a different index on a continuation frame moves the call. Pinned.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", index: 3 });
    expect(trackToolCall(tracker, { id: "a", index: 9 }).index).toBe(9);
    expect(tracker.indexById.get("a")).toBe(9);
  });

  test("a negative explicit index is rejected", () => {
    // `index >= 0` — a negative index is not a position in the client's array.
    const tracker = createToolCallTracker();
    expect(trackToolCall(tracker, { id: "a", index: -1 }).index).toBe(0);
    expect(tracker.indexById.get("a")).toBe(0);
  });

  test("a non-integer explicit index is rejected", () => {
    // `Number.isInteger` — 1.5 and NaN are not wire indexes.
    const tracker = createToolCallTracker();
    expect(trackToolCall(tracker, { id: "a", index: 1.5 }).index).toBe(0);
    expect(trackToolCall(tracker, { id: "b", index: Number.NaN }).index).toBe(1);
  });

  test("a zero explicit index is accepted, not treated as absent", () => {
    // The discriminating case for the `!== undefined` check: 0 is a valid wire
    // index and a truthiness test would drop it.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a" });
    expect(trackToolCall(tracker, { id: "b", index: 0 }).index).toBe(0);
  });

  test("the fallback index is used when there is no explicit index", () => {
    // The Messages ledger shares one counter across tool and non-tool blocks, so
    // it passes its own position in.
    const tracker = createToolCallTracker();
    expect(trackToolCall(tracker, { id: "a" }, 4).index).toBe(4);
  });

  test("the fallback index also advances the counter past itself", () => {
    // MEASURED — I first asserted `nextIndex` stayed 0 here and was wrong. The
    // `++` in `fallbackIndex ?? tracker.nextIndex++` is indeed not evaluated, but
    // the very next line is
    //   `tracker.nextIndex = Math.max(tracker.nextIndex, index + 1)`
    // which advances the counter to the fallback's own index + 1 regardless of
    // which branch chose the index. So a ledger passing 4 leaves `nextIndex` at 5.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a" }, 4);
    expect(tracker.nextIndex).toBe(5);
    // And a later auto-indexed call continues from there rather than reusing 4.
    expect(trackToolCall(tracker, { id: "b" }).index).toBe(5);
  });

  test("a fallback of zero advances the counter to 1", () => {
    // The same rule at the boundary: `Math.max(0, 0 + 1)`.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a" }, 0);
    expect(tracker.nextIndex).toBe(1);
  });

  test("a fallback of zero is used, not skipped as falsy", () => {
    // The `??` operator, not `||`.
    const tracker = createToolCallTracker();
    expect(trackToolCall(tracker, { id: "a" }, 0).index).toBe(0);
  });

  test("a known id prefers its pinned index over the fallback", () => {
    // The ledger's fallback advances for non-tool blocks; a continuation of a
    // known call must not be moved to it.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", index: 2 });
    expect(trackToolCall(tracker, { id: "a" }, 99).index).toBe(2);
  });

  test("a known id prefers its pinned index over the counter", () => {
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a" });
    trackToolCall(tracker, { id: "b" });
    expect(trackToolCall(tracker, { id: "a" }).index).toBe(0);
  });

  test("two calls with the same explicit index both keep it", () => {
    // MEASURED: nothing de-duplicates indexes. A provider that sends the same
    // index for two ids gets two states on that index, and the client's
    // accumulation merges them. Pinned: the tracker's contract is to honor the
    // wire, not to repair it.
    const tracker = createToolCallTracker();
    expect(trackToolCall(tracker, { id: "a", index: 1 }).index).toBe(1);
    expect(trackToolCall(tracker, { id: "b", index: 1 }).index).toBe(1);
    expect(tracker.states.size).toBe(2);
  });
});

describe("trackToolCall — argument accumulation", () => {
  test("fragments are joined in arrival order", () => {
    // The client reconstructs the JSON arguments from these deltas, so order is
    // the whole value.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", name: "search", args: '{"q":' });
    trackToolCall(tracker, { id: "a", args: '"hel' });
    trackToolCall(tracker, { id: "a", args: 'lo"}' });
    expect(argsOf(tracker, "a")).toBe('{"q":"hello"}');
  });

  test("a call with no args yet has empty arguments", () => {
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", name: "search" });
    expect(argsOf(tracker, "a")).toBe("");
  });

  test("an explicit empty args fragment is a no-op on the accumulated value", () => {
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", args: "{}" });
    trackToolCall(tracker, { id: "a", args: "" });
    expect(argsOf(tracker, "a")).toBe("{}");
  });

  test("accumulation is linear, not quadratic, in the number of fragments", () => {
    // The chunk array exists so N deltas cost O(N) rather than O(N²) prefix
    // copies. This asserts the RESULT is still correct at a size where a
    // quadratic implementation would be visibly slow; it does not measure time
    // (that would be a flaky assertion), it measures that every fragment
    // survived.
    const tracker = createToolCallTracker();
    const fragments = Array.from({ length: 5_000 }, (_value, index) => `${index % 10}`);
    for (const fragment of fragments) trackToolCall(tracker, { id: "a", args: fragment });
    expect(argsOf(tracker, "a")).toBe(fragments.join(""));
    expect(argsOf(tracker, "a")).toHaveLength(5_000);
  });

  test("arguments accumulate per id, not across ids", () => {
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", args: "AA" });
    trackToolCall(tracker, { id: "b", args: "BB" });
    trackToolCall(tracker, { id: "a", args: "aa" });
    expect(argsOf(tracker, "a")).toBe("AAaa");
    expect(argsOf(tracker, "b")).toBe("BB");
  });

  test("MEASURED: a superseded state's arguments keep growing with the live one", () => {
    // The chunk array is handed forward from the prior state to its replacement
    // and then MUTATED in place (`chunks.push(...)`), so a reader holding the
    // older `ToolCallState` object sees the newest total. The module's comment
    // says this is safe because "superseded states are never read after
    // replacement" — this test pins that assumption rather than asserting it away,
    // because a caller that retains a state (to render an earlier frame, say)
    // would render a value that never existed at that point in the stream.
    //
    // The states are distinct objects, so the sharing is in the chunk array only.
    const tracker = createToolCallTracker();
    const first = trackToolCall(tracker, { id: "a", args: "1" });
    const second = trackToolCall(tracker, { id: "a", args: "2" });

    expect(first.state).not.toBe(second.state);
    expect(second.state.arguments).toBe("12");
    expect(first.state.arguments).toBe("12");
  });

  test("the value read immediately after each frame is correct", () => {
    // The supported read pattern, which is why the above is tolerable: a caller
    // that reads the state it was just handed sees the right value.
    const tracker = createToolCallTracker();
    expect(trackToolCall(tracker, { id: "a", args: "1" }).state.arguments).toBe("1");
    expect(trackToolCall(tracker, { id: "a", args: "2" }).state.arguments).toBe("12");
    expect(trackToolCall(tracker, { id: "a", args: "3" }).state.arguments).toBe("123");
  });

  test("the accumulated value is a plain string, not a live view", () => {
    // A reader can hold the value without it changing under them.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", args: "x" });
    const snapshot = argsOf(tracker, "a");
    trackToolCall(tracker, { id: "a", args: "y" });
    expect(snapshot).toBe("x");
  });

  test("a large single fragment is preserved exactly", () => {
    // A provider that sends the whole argument object in one frame.
    const tracker = createToolCallTracker();
    const big = `{"data":"${"z".repeat(100_000)}"}`;
    trackToolCall(tracker, { id: "a", args: big });
    expect(argsOf(tracker, "a")).toBe(big);
  });
});

describe("trackToolCall — name stickiness", () => {
  test("the first defined name is kept when later frames omit it", () => {
    // The documented rule: names are sticky. A delta frame carrying only
    // arguments must not erase the name the opening frame established.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", name: "search", args: "{" });
    trackToolCall(tracker, { id: "a", args: "}" });
    expect(tracker.states.get("a")?.name).toBe("search");
  });

  test("a later frame can replace the name", () => {
    // MEASURED: "first defined wins" is not enforced — `tool.name ?? prior?.name`
    // means any frame that DOES carry a name overwrites it. Pinned because the
    // doc comment reads as if the first name is immutable.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", name: "first" });
    trackToolCall(tracker, { id: "a", name: "second" });
    expect(tracker.states.get("a")?.name).toBe("second");
  });

  test("an empty-string name is treated as defined and replaces the prior", () => {
    // `??` only falls back on undefined/null, so `""` wins. This is the Muse
    // `` `name` must be non-empty `` failure's origin on this path: an empty name
    // on a continuation frame erases a good one.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", name: "search" });
    trackToolCall(tracker, { id: "a", name: "" });
    expect(tracker.states.get("a")?.name).toBe("");
  });

  test("a call that never had a name has no name property", () => {
    // The state is built without `name` and the assignment is guarded, so the key
    // is absent rather than present-and-undefined.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", args: "{}" });
    expect(tracker.states.get("a")).not.toHaveProperty("name");
  });

  test("names do not leak between ids", () => {
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", name: "search" });
    trackToolCall(tracker, { id: "b", args: "{}" });
    expect(tracker.states.get("b")).not.toHaveProperty("name");
  });
});

describe("trackToolCall — id handling", () => {
  test("the id is the map key and the state's own id", () => {
    const tracker = createToolCallTracker();
    const result = trackToolCall(tracker, { id: "call_abc", name: "search" });
    expect(result.state.id).toBe("call_abc");
    expect(tracker.states.get("call_abc")).toBe(result.state);
  });

  test("MEASURED: the `prior?.id` fallback in `tool.id || prior?.id` is unreachable", () => {
    // I first asserted an empty id would inherit the prior state's id and was
    // wrong. The mechanism: `prior` is `tracker.states.get(tool.id)`, looked up
    // by the RAW id. For `prior` to be defined, `tool.id` must already be a key
    // in the map — and the only way to get there is a previous call with that
    // same id. But a non-empty string is truthy, so `tool.id || prior?.id`
    // short-circuits and returns `tool.id`. The right operand can never be
    // reached. An empty id therefore produces an empty state id and a new entry
    // under the empty key, and `isFirst` is true because nothing was found there.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "a", name: "search" });
    const result = trackToolCall(tracker, { id: "", args: "{}" });

    expect(result.state.id).toBe("");
    expect(result.isFirst).toBe(true);
    expect(result.state).not.toHaveProperty("name");
    // Two distinct entries: the empty-keyed one did not merge into "a".
    expect(tracker.states.size).toBe(2);
    expect(tracker.states.get("a")?.arguments).toBe("");
    expect(tracker.states.get("")?.arguments).toBe("{}");
  });

  test("an empty id on a fresh call produces an empty id", () => {
    const tracker = createToolCallTracker();
    expect(trackToolCall(tracker, { id: "", args: "{}" }).state.id).toBe("");
  });

  test("two empty-id calls share one entry", () => {
    // The consequence of keying on the raw id: id-less frames collapse onto the
    // empty key, so the second is a continuation rather than a new call. This is
    // why the ledger has `nextOrphanId`.
    const tracker = createToolCallTracker();
    const first = trackToolCall(tracker, { id: "", args: "A" });
    const second = trackToolCall(tracker, { id: "", args: "B" });
    expect(first.isFirst).toBe(true);
    expect(second.isFirst).toBe(false);
    expect(tracker.states.size).toBe(1);
    expect(argsOf(tracker, "")).toBe("AB");
  });

  test("ids that differ only in case are different calls", () => {
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "abc" });
    expect(trackToolCall(tracker, { id: "ABC" }).isFirst).toBe(true);
  });

  test("`call_x` and `fc_x` are different calls to the tracker", () => {
    // The prefix collapsing lives in the LEDGER, not the tracker. Pinned so the
    // split of responsibility between the two modules is explicit — the tracker
    // keys on the raw id.
    const tracker = createToolCallTracker();
    trackToolCall(tracker, { id: "call_x", name: "search" });
    const second = trackToolCall(tracker, { id: "fc_x", name: "search" });
    expect(second.isFirst).toBe(true);
    expect(tracker.states.size).toBe(2);
  });
});

describe("createToolEmitLedger — claimFirstEmission", () => {
  test("the first claim for an id succeeds, the second does not", () => {
    // The single gate for call-defining events: a duplicate reaches the client
    // zero times by construction.
    const ledger = createToolEmitLedger();
    expect(ledger.claimFirstEmission("call_a", "search", "{}")).toBe(true);
    expect(ledger.claimFirstEmission("call_a", "search", "{}")).toBe(false);
  });

  test("the two provider prefixes share one claim", () => {
    // The reason `toolIdentityKey` exists: one call under two spellings must
    // define once.
    const ledger = createToolEmitLedger();
    expect(ledger.claimFirstEmission("call_abc", "search", "{}")).toBe(true);
    expect(ledger.claimFirstEmission("fc_abc", "search", "{}")).toBe(false);
  });

  test("the prefix collapse is symmetric", () => {
    // Whichever spelling arrives first claims it.
    const ledger = createToolEmitLedger();
    expect(ledger.claimFirstEmission("fc_abc", "search", "{}")).toBe(true);
    expect(ledger.claimFirstEmission("call_abc", "search", "{}")).toBe(false);
  });

  test("different ids each claim independently", () => {
    const ledger = createToolEmitLedger();
    expect(ledger.claimFirstEmission("call_a", "search", "{}")).toBe(true);
    expect(ledger.claimFirstEmission("call_b", "search", "{}")).toBe(true);
  });

  test("a claim with no name or args still marks the call seen", () => {
    // The entry is created regardless, so a later frame with the payload is
    // still a duplicate.
    const ledger = createToolEmitLedger();
    expect(ledger.claimFirstEmission("call_a")).toBe(true);
    expect(ledger.claimFirstEmission("call_a", "search", "{}")).toBe(false);
  });

  test("an empty call id is claimable once", () => {
    // The degenerate case: every id-less frame shares one claim, so only the
    // first is emitted. `nextOrphanId` is the escape hatch for that case.
    const ledger = createToolEmitLedger();
    expect(ledger.claimFirstEmission("")).toBe(true);
    expect(ledger.claimFirstEmission("")).toBe(false);
  });
});

describe("createToolEmitLedger — streamed arguments", () => {
  test("a fresh call has not streamed arguments", () => {
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("call_a", "search");
    expect(ledger.hasStreamedArguments("call_a")).toBe(false);
  });

  test("an unknown call has not streamed arguments", () => {
    // `entries.get(...)?.streamedArguments === true` — an absent entry reads as
    // false rather than throwing.
    expect(createToolEmitLedger().hasStreamedArguments("never-seen")).toBe(false);
  });

  test("marking sets the flag for that call only", () => {
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("call_a");
    ledger.claimFirstEmission("call_b");
    ledger.markStreamedArguments("call_a");
    expect(ledger.hasStreamedArguments("call_a")).toBe(true);
    expect(ledger.hasStreamedArguments("call_b")).toBe(false);
  });

  test("marking an unknown call creates the entry", () => {
    // Documented: a delta arriving before any defining frame must still be
    // recorded, so the terminal frame cannot re-emit the full `arguments`.
    const ledger = createToolEmitLedger();
    ledger.markStreamedArguments("call_a");
    expect(ledger.hasStreamedArguments("call_a")).toBe(true);
  });

  test("marking through one prefix is visible through the other", () => {
    // The flag is keyed by identity, so the aliasing holds here too.
    const ledger = createToolEmitLedger();
    ledger.markStreamedArguments("call_abc");
    expect(ledger.hasStreamedArguments("fc_abc")).toBe(true);
  });

  test("marking is idempotent", () => {
    const ledger = createToolEmitLedger();
    ledger.markStreamedArguments("call_a");
    ledger.markStreamedArguments("call_a");
    expect(ledger.hasStreamedArguments("call_a")).toBe(true);
  });

  test("an entry created by marking blocks a later claim", () => {
    // MEASURED, and it is the point of the create-on-mark behaviour: a delta
    // that arrived first means the call is already known, so its defining frame
    // must not be emitted again.
    const ledger = createToolEmitLedger();
    ledger.markStreamedArguments("call_a");
    expect(ledger.claimFirstEmission("call_a", "search", "{}")).toBe(false);
  });
});

describe("createToolEmitLedger — isDuplicateDefinition", () => {
  test("an empty argument list is never a duplicate", () => {
    // The documented rule, and the reason it exists: two parallel calls to the
    // same tool both start at `arguments: ""`, so collapsing on that basis
    // suppresses the second call's name — and the client then replays upstream
    // with `name: ""`, which Muse rejects.
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("call_a", "search", "");
    expect(ledger.isDuplicateDefinition("other-id", "search", "")).toBe(false);
  });

  test("whitespace-only arguments are also treated as empty", () => {
    // `args.trim().length === 0`, so `"  "` is not identity-bearing evidence.
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("call_a", "search", "   ");
    expect(ledger.isDuplicateDefinition("other-id", "search", "   ")).toBe(false);
    expect(ledger.isDuplicateDefinition("other-id", "search", "\n\t")).toBe(false);
  });

  test("a known prefixed id is never a duplicate by name+args", () => {
    // Documented: applying the name+args fallback to known ids would suppress
    // two legitimate identical parallel calls.
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("call_a", "search", '{"q":"x"}');
    expect(ledger.isDuplicateDefinition("call_b", "search", '{"q":"x"}')).toBe(false);
    expect(ledger.isDuplicateDefinition("fc_c", "search", '{"q":"x"}')).toBe(false);
  });

  test("an unprefixed id with matching name and args IS a duplicate", () => {
    // The case the fallback exists for: an unknown provider prefix delivering one
    // call under two ids.
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("id-one", "search", '{"q":"x"}');
    expect(ledger.isDuplicateDefinition("id-two", "search", '{"q":"x"}')).toBe(true);
  });

  test("a same-id repeat is never a duplicate", () => {
    // Documented: same-id repeats are continuations.
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("id-one", "search", '{"q":"x"}');
    expect(ledger.isDuplicateDefinition("id-one", "search", '{"q":"x"}')).toBe(false);
  });

  test("a different name with the same args is not a duplicate", () => {
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("id-one", "search", '{"q":"x"}');
    expect(ledger.isDuplicateDefinition("id-two", "read", '{"q":"x"}')).toBe(false);
  });

  test("a different args value with the same name is not a duplicate", () => {
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("id-one", "search", '{"q":"x"}');
    expect(ledger.isDuplicateDefinition("id-two", "search", '{"q":"y"}')).toBe(false);
  });

  test("a differently-prefixed id of the same call is not a duplicate", () => {
    // `call_a` and `fc_a` are ONE call, so comparing them by name+args would be
    // wrong — and the prefix guard returns false first anyway.
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("call_a", "search", '{"q":"x"}');
    expect(ledger.isDuplicateDefinition("fc_a", "search", '{"q":"x"}')).toBe(false);
  });

  test("an unknown id against an empty ledger is not a duplicate", () => {
    expect(createToolEmitLedger().isDuplicateDefinition("id", "search", "{}")).toBe(false);
  });

  test("an entry created by marking does not match on name+args", () => {
    // `markStreamedArguments` creates `{ streamedArguments: true }` with no name
    // or arguments, so it can never satisfy the name+args comparison.
    const ledger = createToolEmitLedger();
    ledger.markStreamedArguments("id-one");
    expect(ledger.isDuplicateDefinition("id-two", "search", "{}")).toBe(false);
  });

  test("the args comparison is exact, not normalized", () => {
    // Key order and whitespace differences are different strings, so two frames
    // that a human would call identical are not collapsed. Pinned: normalization
    // would risk merging genuinely different calls.
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("id-one", "search", '{"a":1,"b":2}');
    expect(ledger.isDuplicateDefinition("id-two", "search", '{"b":2,"a":1}')).toBe(false);
    expect(ledger.isDuplicateDefinition("id-two", "search", '{"a":1, "b":2}')).toBe(false);
  });

  test("the FIRST match wins across several entries", () => {
    // The loop scans every entry and returns on the first name+args match; the
    // result is a boolean so the order does not matter, but the scan must not
    // stop early on a non-matching entry.
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("id-one", "read", "{}");
    ledger.claimFirstEmission("id-two", "search", '{"q":"x"}');
    ledger.claimFirstEmission("id-three", "write", "[]");
    expect(ledger.isDuplicateDefinition("id-four", "write", "[]")).toBe(true);
  });

  test("an empty ledger after reset reports no duplicates", () => {
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("id-one", "search", "{}");
    ledger.reset();
    expect(ledger.isDuplicateDefinition("id-two", "search", "{}")).toBe(false);
  });
});

describe("createToolEmitLedger — nextOrphanId and reset", () => {
  test("orphan ids are unique and prefixed", () => {
    // For an item carrying no identity, so parallel calls never merge.
    const ledger = createToolEmitLedger();
    const first = ledger.nextOrphanId("tool");
    const second = ledger.nextOrphanId("tool");
    expect(first).not.toBe(second);
    expect(first).toStartWith("tool-orphan-");
    expect(second).toStartWith("tool-orphan-");
  });

  test("orphan ids are unique across different prefixes", () => {
    // The counter is shared, so even two prefixes cannot collide.
    const ledger = createToolEmitLedger();
    expect(ledger.nextOrphanId("a")).not.toBe(ledger.nextOrphanId("b"));
  });

  test("orphan ids are claimable as ordinary calls", () => {
    // The end-to-end use: two id-less frames each get a distinct orphan id, so
    // both are emitted rather than the second being collapsed.
    const ledger = createToolEmitLedger();
    const one = ledger.nextOrphanId("call");
    const two = ledger.nextOrphanId("call");
    expect(ledger.claimFirstEmission(one, "search", "{}")).toBe(true);
    expect(ledger.claimFirstEmission(two, "search", "{}")).toBe(true);
  });

  test("reset clears the entries but not the orphan counter", () => {
    // MEASURED: `reset()` calls `entries.clear()` only; `orphanSeq` is left
    // alone. Pinned — a reset ledger keeps handing out increasing orphan ids,
    // which is safe (they remain unique) but is not a full reset.
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("call_a");
    const before = ledger.nextOrphanId("t");
    ledger.reset();
    expect(ledger.hasStreamedArguments("call_a")).toBe(false);
    expect(ledger.nextOrphanId("t")).not.toBe(before);
  });

  test("reset makes a previously claimed call claimable again", () => {
    const ledger = createToolEmitLedger();
    expect(ledger.claimFirstEmission("call_a", "search", "{}")).toBe(true);
    expect(ledger.claimFirstEmission("call_a", "search", "{}")).toBe(false);
    ledger.reset();
    expect(ledger.claimFirstEmission("call_a", "search", "{}")).toBe(true);
  });

  test("reset clears both prefixes of a call", () => {
    const ledger = createToolEmitLedger();
    ledger.claimFirstEmission("call_a", "search", "{}");
    ledger.reset();
    expect(ledger.claimFirstEmission("fc_a", "search", "{}")).toBe(true);
  });
});

describe("tracker and ledger together", () => {
  test("two parallel calls to one tool both survive a tracker pass", () => {
    // The scenario the empty-args rule protects: both calls open with no
    // arguments, both must be tracked as distinct, and the ledger must not
    // collapse the second.
    const tracker = createToolCallTracker();
    const ledger = createToolEmitLedger();

    const first = trackToolCall(tracker, { id: "call_a", name: "search" });
    const second = trackToolCall(tracker, { id: "call_b", name: "search" });

    expect(first.index).not.toBe(second.index);
    expect(ledger.claimFirstEmission("call_a", "search", "")).toBe(true);
    expect(ledger.claimFirstEmission("call_b", "search", "")).toBe(true);
    expect(ledger.isDuplicateDefinition("call_b", "search", "")).toBe(false);
  });

  test("one call under two provider prefixes is emitted once and tracked twice", () => {
    // Pins the actual division of labour: the LEDGER de-duplicates by identity,
    // the TRACKER does not. A caller that routes both spellings through the
    // tracker gets two states — which is why the ledger gate is the one that
    // matters for emission.
    const tracker = createToolCallTracker();
    const ledger = createToolEmitLedger();

    expect(ledger.claimFirstEmission("call_abc", "search", '{"q":')).toBe(true);
    trackToolCall(tracker, { id: "call_abc", name: "search", args: '{"q":' });
    expect(ledger.claimFirstEmission("fc_abc", "search", '{"q":')).toBe(false);
    trackToolCall(tracker, { id: "fc_abc", name: "search", args: '{"q":' });

    expect(tracker.states.size).toBe(2);
    expect(argsOf(tracker, "call_abc")).toBe('{"q":');
    expect(argsOf(tracker, "fc_abc")).toBe('{"q":');
  });

  test("a streamed call is tracked with its full arguments and marked", () => {
    const tracker = createToolCallTracker();
    const ledger = createToolEmitLedger();

    ledger.claimFirstEmission("call_a", "search");
    trackToolCall(tracker, { id: "call_a", name: "search", args: '{"q":' });
    ledger.markStreamedArguments("call_a");
    trackToolCall(tracker, { id: "call_a", args: '"hello"}' });

    expect(argsOf(tracker, "call_a")).toBe('{"q":"hello"}');
    expect(ledger.hasStreamedArguments("call_a")).toBe(true);
    expect(tracker.states.get("call_a")?.index).toBe(0);
  });
});
