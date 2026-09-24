import { beforeEach, describe, expect, test } from "bun:test";
import {
  _resetGrokTurnIndexForTests,
  resolveGrokTurnIndex,
} from "../../../../src/providers/integrations/grok/grok-turn-index";
import type { CanonicalRequest } from "../../../../src/transport/canonical-model";

function requestWithUserTurns(count: number): CanonicalRequest {
  return {
    model: "grok-4.6",
    messages: Array.from({ length: count }, () => ({
      role: "user" as const,
      content: [{ kind: "text" as const, text: "hi" }],
    })),
  } as unknown as CanonicalRequest;
}

beforeEach(() => {
  _resetGrokTurnIndexForTests();
});

describe("resolveGrokTurnIndex", () => {
  test("first call for a session reports its own user-turn count", () => {
    expect(resolveGrokTurnIndex("session-1", requestWithUserTurns(1))).toBe(1);
    _resetGrokTurnIndexForTests();
    expect(resolveGrokTurnIndex("session-2", requestWithUserTurns(5))).toBe(5);
  });

  test("a delta-style client advances instead of pinning at 1", () => {
    // Every request carries one user message, but each is a new turn.
    expect(resolveGrokTurnIndex("session-1", requestWithUserTurns(1))).toBe(1);
    expect(resolveGrokTurnIndex("session-1", requestWithUserTurns(1))).toBe(2);
    expect(resolveGrokTurnIndex("session-1", requestWithUserTurns(1))).toBe(3);
  });

  test("a full-history client keeps its own larger count", () => {
    // The stored index must never drag a client that reports the true index.
    expect(resolveGrokTurnIndex("session-1", requestWithUserTurns(5))).toBe(5);
    expect(resolveGrokTurnIndex("session-1", requestWithUserTurns(6))).toBe(6);
  });

  test("the index never regresses for one session", () => {
    expect(resolveGrokTurnIndex("session-1", requestWithUserTurns(4))).toBe(4);
    // A shorter payload (a client trimming history) still advances.
    expect(resolveGrokTurnIndex("session-1", requestWithUserTurns(2))).toBe(5);
  });

  test("sessions are tracked independently", () => {
    expect(resolveGrokTurnIndex("session-1", requestWithUserTurns(1))).toBe(1);
    expect(resolveGrokTurnIndex("session-2", requestWithUserTurns(1))).toBe(1);
    expect(resolveGrokTurnIndex("session-1", requestWithUserTurns(1))).toBe(2);
    expect(resolveGrokTurnIndex("session-2", requestWithUserTurns(1))).toBe(2);
  });

  test("an unknown session returns the payload count without storing", () => {
    expect(resolveGrokTurnIndex(undefined, requestWithUserTurns(1))).toBe(1);
    expect(resolveGrokTurnIndex(undefined, requestWithUserTurns(1))).toBe(1);
    expect(resolveGrokTurnIndex("", requestWithUserTurns(3))).toBe(3);
    expect(resolveGrokTurnIndex("", requestWithUserTurns(3))).toBe(3);
  });

  test("a request with no messages is still turn 1", () => {
    expect(resolveGrokTurnIndex("session-1", { model: "grok-4.6" } as unknown as CanonicalRequest)).toBe(1);
  });

  test("the reset helper forgets remembered sessions", () => {
    expect(resolveGrokTurnIndex("session-1", requestWithUserTurns(1))).toBe(1);
    expect(resolveGrokTurnIndex("session-1", requestWithUserTurns(1))).toBe(2);
    _resetGrokTurnIndexForTests();
    expect(resolveGrokTurnIndex("session-1", requestWithUserTurns(1))).toBe(1);
  });
});
