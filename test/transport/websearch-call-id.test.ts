/**
 * A served search round is addressed back to the client's own tool call.
 *
 * Claude Code and Codex CLI send a hosted search as an ordinary tool round and
 * keep that call pending until they see its `tool_use_id` come back:
 *
 *     assistant: tool_use   {id: "toolu_01ABC…", name: "web_search"}
 *     user:      tool_result{tool_use_id: "toolu_01ABC…", content: […]}
 *
 * The Messages contract requires `tool_result.tool_use_id` to reference a
 * preceding `tool_use` id. The bridge used to mint its own id from the provider,
 * the query length, and the hit count, so the result was addressed to a call the
 * client never made. Its round could not close, so it re-issued the search — the
 * "web search loops forever" report.
 *
 * These assertions are about the *pairing*, not the payload: both halves of one
 * served round (what the upstream is given, and what the client is shown) must
 * agree on the id, and it must be the client's.
 */
import { describe, expect, test } from "bun:test";
import {
  servedSearchEvents,
  withServedWebSearch,
  type WebSearchBridgeResult,
} from "../../src/transport/dispatch/websearch-bridge";
import { extractWebSearchInvocation } from "../../src/transport/translation/search";
import type { CanonicalEvent, CanonicalRequest } from "../../src/protocol/canonical-model";
import type { WebSearchOutcome } from "../../src/providers/contracts";

/** The id a hosted-search client actually sends. */
const CLIENT_CALL_ID = "toolu_01ArealClientCallId";

function hits(): WebSearchOutcome {
  return {
    results: [
      { title: "One", url: "https://example.com/one", snippet: "first" },
      { title: "Two", url: "https://example.com/two", snippet: "second" },
    ],
  } as unknown as WebSearchOutcome;
}

function served(overrides: Partial<WebSearchBridgeResult> = {}): WebSearchBridgeResult {
  return {
    providerId: "exa",
    modelId: "exa",
    query: "who is risuncode",
    results: hits(),
    ...overrides,
  };
}

/** A Claude Code Messages request: a hosted tool declaration plus one pending call. */
function requestWithHostedCall(): CanonicalRequest {
  return {
    source_surface: "messages",
    messages: [
      { role: "user", content: [{ kind: "text", text: "who is risuncode" }] },
      {
        role: "assistant",
        content: [
          {
            kind: "toolCall",
            call_id: CLIENT_CALL_ID,
            name: "web_search",
            arguments: { query: "who is risuncode" },
          },
        ],
      },
    ],
    tools: [{ type: "hosted", name: "web_search" }],
  } as unknown as CanonicalRequest;
}

/**
 * The search blocks the client is shown, as loose records.
 *
 * `CanonicalEvent` is a discriminated union whose payload shape varies per
 * member, and the extension blocks the bridge emits are deliberately opaque, so
 * the assertions here read them structurally rather than narrowing the union.
 */
function payloads(events: readonly CanonicalEvent[]): { type?: unknown; tool_use_id?: unknown; id?: unknown }[] {
  const found: { type?: unknown; tool_use_id?: unknown; id?: unknown }[] = [];
  for (const event of events) {
    const content: unknown = (event as { content?: unknown }).content;
    if (content === null || typeof content !== "object") continue;
    const part = content as { kind?: unknown; payload?: unknown };
    if (part.kind !== "extension" || part.payload === null || typeof part.payload !== "object") continue;
    found.push(part.payload as { type?: unknown; tool_use_id?: unknown; id?: unknown });
  }
  return found;
}

function searchBlocks(events: readonly CanonicalEvent[], type: string) {
  return payloads(events).filter((payload) => payload.type === type);
}

/** The `web_search_tool_result` block the client is shown, if any. */
function toolResultBlock(events: readonly CanonicalEvent[]) {
  return searchBlocks(events, "web_search_tool_result")[0];
}

/** The `server_tool_use` block the client is shown, if any. */
function toolUseBlock(events: readonly CanonicalEvent[]) {
  return searchBlocks(events, "server_tool_use")[0];
}

describe("extractWebSearchInvocation — the client's call id survives extraction", () => {
  test("carries the pending call's id through", () => {
    // The whole fix rests on this: the id was read off the part and then dropped.
    expect(extractWebSearchInvocation(requestWithHostedCall())?.callId).toBe(CLIENT_CALL_ID);
  });

  test("a prose query carries no call id", () => {
    // Nothing to pair with, so the gateway mints its own — and says so by
    // leaving this absent rather than inventing an id a client never sent.
    const prose = {
      source_surface: "messages",
      messages: [{ role: "user", content: [{ kind: "text", text: "who is risuncode" }] }],
    } as unknown as CanonicalRequest;
    expect(extractWebSearchInvocation(prose)?.callId).toBeUndefined();
  });
});

describe("servedSearchEvents — the result is addressed to the client's call", () => {
  test("the tool result carries the client's own tool_use_id", () => {
    const events = servedSearchEvents(served({ callId: CLIENT_CALL_ID }), "messages");
    expect(toolResultBlock(events)?.tool_use_id).toBe(CLIENT_CALL_ID);
  });

  test("the server_tool_use half carries the same id", () => {
    // Both halves of one round must agree, or the client sees a use it cannot
    // match to a result.
    const events = servedSearchEvents(served({ callId: CLIENT_CALL_ID }), "messages");
    expect(toolUseBlock(events)?.id).toBe(CLIENT_CALL_ID);
  });

  test("the id is never the gateway's content-derived one when a client call exists", () => {
    const events = servedSearchEvents(served({ callId: CLIENT_CALL_ID }), "messages");
    const payload = toolResultBlock(events);
    expect(payload?.tool_use_id).not.toContain("srvtoolu");
  });

  test("with no client call the gateway still emits a usable id", () => {
    // A prose-derived search has nothing to address; it must not emit an empty
    // or shared id.
    const events = servedSearchEvents(served(), "messages");
    const payload = toolResultBlock(events);
    expect(payload?.tool_use_id).toBeTruthy();
  });
});

describe("servedSearchEvents — two rounds in one conversation do not share an id", () => {
  test("distinct ids when no client call is present", () => {
    // The old id was derived from provider + query length + hit count, so two
    // rounds sharing those values produced one identical `tool_use_id` — which
    // the same contract forbids inside one conversation.
    const a = servedSearchEvents(served(), "messages");
    const b = servedSearchEvents(served(), "messages");
    expect(toolResultBlock(a)?.tool_use_id).not.toBe(toolResultBlock(b)?.tool_use_id);
  });
});

describe("withServedWebSearch — the upstream injection uses the same id", () => {
  test("the injected tool round is addressed to the client's call", () => {
    const projected = withServedWebSearch(requestWithHostedCall(), served({ callId: CLIENT_CALL_ID }));
    const round = projected.messages
      .flatMap((message) => message.content)
      .find((part) => part.kind === "toolResult");
    expect(part_idOf(round)).toBe(CLIENT_CALL_ID);
  });

  test("the client's original call is preserved untouched", () => {
    // The round must still contain the call the client made, not a replacement.
    const projected = withServedWebSearch(requestWithHostedCall(), served({ callId: CLIENT_CALL_ID }));
    const calls = projected.messages
      .flatMap((message) => message.content)
      .filter((part) => part.kind === "toolCall");
    expect(calls.map((part) => part_idOf(part))).toContain(CLIENT_CALL_ID);
  });
});

/** Reads a canonical part's id without narrowing the whole union at each site. */
function part_idOf(part: unknown): string | undefined {
  if (part === null || typeof part !== "object") return undefined;
  const record = part as { call_id?: unknown };
  return typeof record.call_id === "string" ? record.call_id : undefined;
}
