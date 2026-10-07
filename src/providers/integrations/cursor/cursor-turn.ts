/**
 * One Cursor turn.
 *
 * History travels out of band: each entry is stored under its sha256 and only
 * the ids go in the request, then the server pulls the bytes back mid-stream
 * over the KV channel. Tool calls are the caller's to execute, so an
 * `mcp_args` frame ends the turn with `tool_calls` instead of being answered
 * here; the caller replays the result as history on its next request.
 */
import { createHash, randomUUID } from "node:crypto";
import { encodeGetBlobResult, encodeRequestContextResult, encodeRunRequest, encodeSetBlobResult, decodeServerMessage, type CursorTool } from "./cursor-messages";
import { encodeMessage } from "./cursor-wire";
import { openRunStream, type CursorCallContext } from "./cursor-transport";

export type TurnEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "thinking"; readonly delta: string }
  | { readonly type: "tool_call"; readonly id: string; readonly name: string; readonly args: Record<string, unknown> }
  | { readonly type: "usage"; readonly outputTokens: number }
  | { readonly type: "done"; readonly reason: "stop" | "tool_calls" | "error"; readonly error?: string; readonly code?: string };

export interface RunTurnOptions extends CursorCallContext {
  readonly modelId: string;
  /** History entries, oldest first, excluding the active user message. */
  readonly rootMessages: readonly unknown[];
  /** The active user message. Absent means the caller is mid tool loop. */
  readonly userText: string | undefined;
  readonly tools: readonly CursorTool[];
  readonly timeoutMs: number;
  readonly allowedNativeTools: readonly string[];
}

/** Upstream ids sometimes contain characters a caller schema rejects. */
export function safeToolCallId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned || `call_${randomUUID()}`;
}

export async function* runTurn(options: RunTurnOptions): AsyncGenerator<TurnEvent> {
  const blobs = new Map<string, Uint8Array>();
  const store = (data: Uint8Array): Uint8Array => {
    const id = createHash("sha256").update(data).digest();
    blobs.set(Buffer.from(id).toString("hex"), data);
    return id;
  };
  const rootPromptMessagesJson = options.rootMessages.map((entry) =>
    store(new TextEncoder().encode(JSON.stringify(entry))),
  );

  const stream = openRunStream(options);
  // `Run` carries `AgentClientMessage`, and `run_request` is its field 1. The
  // bare request is not a message the server accepts.
  stream.send(encodeMessage(1, encodeRunRequest({
    rootPromptMessagesJson,
    ...(options.userText !== undefined ? { userText: options.userText } : {}),
    userMessageId: randomUUID(),
    modelId: options.modelId,
    conversationId: randomUUID(),
    tools: options.tools,
  })));

  let toolCallSeen = false;
  for await (const frame of stream.frames()) {
    if (frame.end) {
      yield endStreamEvent(frame.payload, toolCallSeen);
      return;
    }
    const event = decodeServerMessage(frame.payload);
    if (event.type === "get_blob") {
      const data = blobs.get(Buffer.from(event.blobId).toString("hex"));
      stream.send(encodeGetBlobResult(event.id, data));
      continue;
    }
    if (event.type === "set_blob") {
      blobs.set(Buffer.from(event.blobId).toString("hex"), event.blobData);
      stream.send(encodeSetBlobResult(event.id));
      continue;
    }
    if (event.type === "request_context") {
      stream.send(encodeRequestContextResult(event.id, event.execId, { tools: options.tools }));
      continue;
    }
    if (event.type === "text" && event.delta !== "") yield { type: "text", delta: event.delta };
    else if (event.type === "thinking" && event.delta !== "") yield { type: "thinking", delta: event.delta };
    else if (event.type === "usage") yield { type: "usage", outputTokens: event.tokens };
    else if (event.type === "turn_ended") {
      yield { type: "done", reason: toolCallSeen ? "tool_calls" : "stop" };
      return;
    } else if (event.type === "tool_call") {
      toolCallSeen = true;
      yield {
        type: "tool_call",
        id: safeToolCallId(event.call.id),
        name: event.call.name,
        args: decodeArgs(event.call.args),
      };
    }
  }
  yield { type: "done", reason: toolCallSeen ? "tool_calls" : "stop" };
}

function decodeArgs(raw: ReadonlyMap<string, Uint8Array>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of raw) out[key] = decodeArgValue(value);
  return out;
}

/**
 * Each tool argument is a serialized `google.protobuf.Value`. A value that
 * does not decode as one falls back to its raw text.
 */
export function decodeArgValue(bytes: Uint8Array): unknown {
  if (bytes.length === 0) return null;
  try {
    return protoValueToJs(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function protoValueToJs(bytes: Uint8Array): unknown {
  // google.protobuf.Value: oneof kind { null=1, number=2, string=3, bool=4, struct=5, list=6 }.
  const fields = new Map<number, Uint8Array | number>();
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.offset;
    const field = key.value >>> 3;
    const wire = key.value & 0x7;
    if (wire === 0) {
      const read = readVarint(bytes, offset);
      offset = read.offset;
      fields.set(field, read.value);
    } else if (wire === 1) {
      const bits = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
      fields.set(field, bits.getFloat64(0, true));
      offset += 8;
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      fields.set(field, bytes.subarray(offset, offset + length.value));
      offset += length.value;
    } else {
      throw new Error("unsupported value wire type");
    }
  }
  if (fields.has(1)) return null;
  const number = fields.get(2);
  if (typeof number === "number") return number;
  const text = fields.get(3);
  if (text instanceof Uint8Array) return new TextDecoder().decode(text);
  const flag = fields.get(4);
  if (typeof flag === "number") return flag !== 0;
  return null;
}

function readVarint(bytes: Uint8Array, start: number): { readonly value: number; readonly offset: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < bytes.length) {
    const byte = bytes[offset]!;
    offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("truncated varint");
}

function endStreamEvent(payload: Uint8Array, toolCallSeen: boolean): TurnEvent {
  const trailer = new TextDecoder().decode(payload).trim();
  if (!trailer) return { type: "done", reason: toolCallSeen ? "tool_calls" : "stop" };
  try {
    const parsed = JSON.parse(trailer) as { error?: { code?: string; message?: string } };
    if (parsed.error) {
      return {
        type: "done",
        reason: "error",
        ...(parsed.error.code ? { code: parsed.error.code } : {}),
        error: `${parsed.error.code ?? "error"}: ${parsed.error.message ?? trailer}`,
      };
    }
  } catch {
    return { type: "done", reason: "error", error: trailer.slice(0, 500) };
  }
  return { type: "done", reason: "stop" };
}
