import type { CanonicalEvent, CanonicalStopReason, ContentPart, UsageRecord } from "../../canonical-model";
import { isRecord } from "../../../protocol/primitives";
import type { MessagesWireObject } from "./parse";
import { GatewayError } from "../../gateway-error";

/**
 * Requires a provider-emitted tool call to carry a real name before it reaches
 * the Messages wire.
 *
 * `tool_use.name` is mandatory on the wire and the client resolves it against
 * the tools it actually has, so substituting a placeholder like `"tool"`
 * converts a recoverable upstream omission into a confusing "unknown tool"
 * rejection on the client. The inbound parser already refuses a `tool_use`
 * with no name (`parse.ts`), so failing here keeps both wire directions
 * symmetric instead of the outbound side inventing a name.
 */
export function requireMessagesToolName(name: string | undefined, callId: string): string {
  if (typeof name === "string" && name.trim().length > 0) return name;
  throw new GatewayError(
    "transport_unavailable",
    502,
    "Upstream tool call is missing a tool name",
    { callId, reason: "missing_tool_name" },
    "upstream",
  );
}

export function parseArgs(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  // Anthropic requires `input` to be an object: a zero-arg call's "" (or
  // whitespace) must become {}, never be forwarded as a bare string.
  if (value.trim().length === 0) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function blockFromPart(part: ContentPart): MessagesWireObject | undefined {
  switch (part.kind) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return isRecord(part.payload) ? part.payload : { type: "image", source: part.payload };
    case "file":
      return {
        type: "document",
        source: part.file_id
          ? { type: "file", file_id: part.file_id }
          : { type: "base64", media_type: part.media_type, data: part.data },
        ...(part.filename === undefined ? {} : { title: part.filename }),
      };
    case "document":
      return {
        type: "document",
        source: { type: "base64", media_type: part.media_type, data: part.data },
        ...(part.title === undefined ? {} : { title: part.title }),
        ...(part.citations === undefined ? {} : { citations: { enabled: part.citations } }),
      };
    case "audio":
      return { type: "audio", source: { type: "base64", media_type: part.media_type, data: part.data } };
    case "refusal":
      return { type: "text", text: part.text };
    case "toolCall":
      return {
        type: "tool_use",
        id: part.call_id,
        name: part.name,
        input: parseArgs(part.arguments),
        ...(part.index === undefined ? {} : { index: part.index }),
      };
    case "toolResult": {
      const content =
        typeof part.content === "string"
          ? part.content
          : part.content.flatMap((p) => {
              const block = blockFromPart(p);
              return block === undefined ? [] : [block];
            });
      return {
        type: "tool_result",
        tool_use_id: part.call_id,
        content,
        ...(part.is_error ? { is_error: true } : {}),
      };
    }
    case "reasoning": {
      if (part.opaque)
        return isRecord(part.payload)
          ? part.payload
          : { type: "redacted_thinking", data: part.payload };
      return {
        type: "thinking",
        thinking: part.summary ?? (typeof part.payload === "string" ? part.payload : ""),
        ...(part.signature === undefined ? {} : { signature: part.signature }),
      };
    }
    case "extension": {
      if (isRecord(part.payload) && part.name === "server_tool_use") return part.payload;
      if (isRecord(part.payload) && part.name === "search_result") return part.payload;
      if (isRecord(part.payload) && part.name === "document") return part.payload;
      // Messages-native unknown types (`messages:*`, e.g. a newer Anthropic
      // block the parser does not know yet) round-trip under their native
      // type. Foreign-surface annotations (`responses:*`, chat `audio`,
      // `unknown`) have no Messages representation — emitting them would hand
      // strict clients a block type they reject, so they degrade away here.
      if (
        isRecord(part.payload) &&
        part.name.startsWith("messages:") &&
        part.name !== "messages:unknown"
      )
        return {
          type: part.name.slice("messages:".length),
          ...(part.payload as Record<string, unknown>),
        };
      return undefined;
    }
  }
}

export function groupedBlocks(events: readonly CanonicalEvent[]): {
  blocks: MessagesWireObject[];
  droppedUnnamedToolCalls: number;
} {
  const blocks: MessagesWireObject[] = [];
  let previousReasoningSummaryIndex: number | undefined;
  let droppedUnnamedToolCalls = 0;
  // Fragments per call; joined once at flush so N deltas cost O(N), not O(N²).
  const toolArguments = new Map<string, { name?: string; chunks: string[]; index?: number }>();
  const flushTools = (): void => {
    for (const [callId, call] of toolArguments) {
      // Never a placeholder: see `requireMessagesToolName`. A call the
      // upstream never named cannot be expressed on the wire at all, so it is
      // dropped and counted — the caller downgrades `tool_use` to `end_turn`
      // rather than failing the whole response over a recoverable omission.
      if (call.name === undefined || call.name.trim().length === 0) {
        droppedUnnamedToolCalls += 1;
        continue;
      }
      blocks.push({
        type: "tool_use",
        id: callId,
        name: call.name,
        input: parseArgs(call.chunks.join("")),
        ...(call.index === undefined ? {} : { index: call.index }),
      });
    }
    toolArguments.clear();
  };
  for (const event of events) {
    if (event.type === "tool_call_delta") {
      const previous = toolArguments.get(event.call_id);
      const chunks = previous?.chunks ?? [];
      chunks.push(event.arguments_delta ?? "");
      const name = event.name ?? previous?.name;
      toolArguments.set(event.call_id, {
        // Absent until some delta names the call; sticky once seen.
        ...(name === undefined ? {} : { name }),
        chunks,
      });
      continue;
    }
    flushTools();
    if (event.type === "content_delta") {
      // Foreign extensions (responses:*, chat audio, …) have no Messages
      // representation and degrade away instead of reaching the client as a
      // block type it rejects.
      const next = blockFromPart(event.content);
      if (next === undefined) continue;
      const previous = blocks.at(-1);
      if (next.type === "text" && previous?.type === "text") {
        previous.text = `${String(previous.text ?? "")}${String(next.text ?? "")}`;
        previousReasoningSummaryIndex = undefined;
      } else if (next.type === "thinking" && previous?.type === "thinking") {
        const summaryIndex =
          event.content.kind === "reasoning" ? event.content.summary_index : undefined;
        if (
          summaryIndex === undefined ||
          previousReasoningSummaryIndex === undefined ||
          summaryIndex === previousReasoningSummaryIndex
        ) {
          previous.thinking = `${String(previous.thinking ?? "")}${String(next.thinking ?? "")}`;
        } else {
          blocks.push(next);
        }
        previousReasoningSummaryIndex = summaryIndex;
      } else {
        blocks.push(next);
        previousReasoningSummaryIndex =
          next.type === "thinking" && event.content.kind === "reasoning"
            ? event.content.summary_index
            : undefined;
      }
    } else if (event.type === "tool_result") {
      previousReasoningSummaryIndex = undefined;
      const resultBlock = blockFromPart({
        kind: "toolResult",
        call_id: event.call_id,
        content: event.content,
      });
      if (resultBlock !== undefined) blocks.push(resultBlock);
    }
  }
  flushTools();
  return { blocks, droppedUnnamedToolCalls };
}
export function mapStopReason(reason: CanonicalStopReason | undefined): string | null {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "refusal":
    case "content_filter":
      return "refusal";
    case "error":
    case "cancelled":
      return "end_turn";
    case "pause_turn":
      return "pause_turn";
    case undefined:
      return null;
    default:
      reason satisfies never;
      return null;
  }
}

export function startModel(events: readonly CanonicalEvent[]): string | undefined {
  const start = events.find(
    (event) => event.type === "response_start" || event.type === "message_start",
  );
  const model = start !== undefined && "model" in start ? start.model : undefined;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

export function stopData(events: readonly CanonicalEvent[]): {
  reason: string | null;
  usage?: UsageRecord;
  failed: boolean;
} {
  const terminal = [...events]
    .reverse()
    .find(
      (event): event is Extract<CanonicalEvent, { type: "terminal" }> => event.type === "terminal",
    );
  const usageEvent = [...events]
    .reverse()
    .find((event): event is Extract<CanonicalEvent, { type: "usage" }> => event.type === "usage");
  const failed = terminal?.state === "failed";
  let reason: string | null;
  if (terminal?.stop_reason !== undefined) reason = mapStopReason(terminal.stop_reason);
  else reason = terminal?.state === "complete" ? "end_turn" : null;
  if (terminal?.usage !== undefined) return { reason, usage: terminal.usage, failed };
  if (usageEvent?.usage !== undefined) return { reason, usage: usageEvent.usage, failed };
  return { reason, failed };
}
