import type { ProviderUsage, StopReason, StreamEvent } from "../../../application/contracts";

export interface FoldedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

export interface FoldedResponse {
  readonly id: string;
  readonly text: string;
  readonly thinking: string;
  readonly toolCalls: readonly FoldedToolCall[];
  readonly contextItems: readonly Readonly<Record<string, unknown>>[];
  readonly usage: ProviderUsage | null;
  readonly reason: StopReason;
  readonly error?: Readonly<Record<string, unknown>>;
}

export type FoldedResponseItem =
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool_call"; readonly callId: string; readonly name: string; readonly arguments: string }
  | { readonly kind: "server_tool"; readonly block: Readonly<Record<string, unknown>> }
  | { readonly kind: "compaction"; readonly text: string }
  | { readonly kind: "context"; readonly item: Readonly<Record<string, unknown>> };

/** Folds canonical stream semantics into the state needed by non-stream encoders. */
export function foldResponseEvents(events: readonly StreamEvent[]): FoldedResponse {
  let id = "";
  let text = "";
  let thinking = "";
  let usage: ProviderUsage | null = null;
  let reason: StopReason = "completed";
  let error: Readonly<Record<string, unknown>> | undefined;
  const calls = new Map<string, { name: string; arguments: string }>();
  const contextItems: Readonly<Record<string, unknown>>[] = [];

  for (const event of events) {
    if (event.type === "message_start") id = event.id;
    else if (event.type === "thinking_delta") thinking += event.text;
    else if (event.type === "text_delta") text += event.text;
    else if (event.type === "tool_call_start") calls.set(event.callId, { name: event.name, arguments: "" });
    else if (event.type === "tool_call_delta") {
      const current = calls.get(event.callId) ?? { name: "", arguments: "" };
      calls.set(event.callId, { ...current, arguments: current.arguments + event.delta });
    } else if (event.type === "tool_call_end" && !calls.has(event.callId)) {
      calls.set(event.callId, { name: "", arguments: "{}" });
    } else if (event.type === "context_item" && event.phase === "done") contextItems.push(event.item);
    else if (event.type === "usage") usage = event.usage;
    else if (event.type === "message_stop") {
      reason = event.reason;
      error = event.error === undefined ? undefined : { kind: event.error.kind, message: event.error.message };
    }
  }

  return {
    id,
    text,
    thinking,
    toolCalls: [...calls.entries()].map(([callId, value]) => ({ callId, name: value.name, arguments: value.arguments || "{}" })),
    contextItems,
    usage,
    reason,
    ...(error === undefined ? {} : { error }),
  };
}

/** Folds text, reasoning, native blocks, and tool calls without changing event order. */
export function orderedResponseItems(events: readonly StreamEvent[]): readonly FoldedResponseItem[] {
  const items: FoldedResponseItem[] = [];
  const toolIndexes = new Map<string, number>();
  let compactionIndex: number | null = null;
  for (const event of events) {
    if (event.type === "thinking_delta") items.push({ kind: "thinking", text: event.text });
    else if (event.type === "text_delta") items.push({ kind: "text", text: event.text });
    else if (event.type === "server_tool_result") items.push({ kind: "server_tool", block: event.block });
    else if (event.type === "context_item" && event.phase === "done") items.push({ kind: "context", item: event.item });
    else if (event.type === "compaction_start") {
      compactionIndex = items.length;
      items.push({ kind: "compaction", text: "" });
    } else if (event.type === "compaction_delta" && compactionIndex !== null) {
      const current = items[compactionIndex];
      if (current?.kind === "compaction") items[compactionIndex] = { kind: "compaction", text: current.text + event.text };
    } else if (event.type === "tool_call_start") {
      toolIndexes.set(event.callId, items.length);
      items.push({ kind: "tool_call", callId: event.callId, name: event.name, arguments: "" });
    } else if (event.type === "tool_call_delta") {
      const index = toolIndexes.get(event.callId);
      const current = index === undefined ? undefined : items[index];
      if (index !== undefined && current?.kind === "tool_call") items[index] = { ...current, arguments: current.arguments + event.delta };
    } else if (event.type === "tool_call_end") {
      const index = toolIndexes.get(event.callId);
      const current = index === undefined ? undefined : items[index];
      if (index !== undefined && current?.kind === "tool_call" && current.arguments.length === 0) items[index] = { ...current, arguments: "{}" };
    }
  }
  return items;
}

/** Returns the last provider usage event, or null when the source omitted usage. */
export function responseUsage(events: readonly StreamEvent[]): ProviderUsage | null {
  let usage: ProviderUsage | null = null;
  for (const event of events) if (event.type === "usage") usage = event.usage;
  return usage;
}
