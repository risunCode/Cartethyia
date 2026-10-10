import { describe, expect, test } from "bun:test";
import { finishReason } from "../../src/transport/surface/chat/encode";
import { mapStopReason } from "../../src/transport/surface/messages/encode";
import type { CanonicalStopReason } from "../../src/protocol/canonical-model";

const REASONS: readonly CanonicalStopReason[] = [
  "stop",
  "length",
  "tool_use",
  "content_filter",
  "refusal",
  "error",
  "cancelled",
  "pause_turn",
];

/**
 * Wire contract for stop-reason mapping.
 *
 * The four surfaces map the same canonical reason to different wire words, and
 * those words are the contract: Chat reports a refusal as `content_filter` so a
 * refusal is never hidden as a usable completion, while Messages reports its own
 * `refusal`. A refactor that collapses the four tables must not change a single
 * mapping, so each column is pinned here before any consolidation.
 */
describe("stop reason mapping", () => {
  test("chat wire", () => {
    expect(REASONS.map((reason) => [reason, finishReason(reason)])).toEqual([
      ["stop", "stop"],
      ["length", "length"],
      ["tool_use", "tool_calls"],
      ["content_filter", "content_filter"],
      ["refusal", "content_filter"],
      ["error", "error"],
      ["cancelled", "error"],
      ["pause_turn", "stop"],
    ]);
    expect(finishReason(undefined)).toBe("stop");
  });

  test("messages wire", () => {
    expect(REASONS.map((reason) => [reason, mapStopReason(reason)])).toEqual([
      ["stop", "end_turn"],
      ["length", "max_tokens"],
      ["tool_use", "tool_use"],
      ["content_filter", "refusal"],
      ["refusal", "refusal"],
      ["error", "end_turn"],
      ["cancelled", "end_turn"],
      ["pause_turn", "pause_turn"],
    ]);
    expect(mapStopReason(undefined)).toBeNull();
  });
});
