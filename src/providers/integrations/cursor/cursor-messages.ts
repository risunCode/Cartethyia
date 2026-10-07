/**
 * The slice of Cursor's `agent.v1` protocol the adapter speaks.
 *
 * Field numbers are Cursor's, taken from its own descriptor. Only the fields
 * we set or read are encoded; everything else is left absent, which proto3
 * treats as the default. Decoding reads the one field it needs and ignores
 * the rest, so a field Cursor adds later does not break a turn.
 */
import {
  allBytes,
  concat,
  decodeBytesMap,
  decodeMessage,
  encodeBytes,
  encodeMessage,
  encodeString,
  encodeVarintField,
  firstBytes,
  firstString,
  firstVarint,
  type WireFields,
} from "./cursor-wire";

export interface CursorTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchemaJson: string;
}

export interface CursorRunRequest {
  /** sha256 ids of the history blobs the server will pull back. */
  readonly rootPromptMessagesJson: readonly Uint8Array[];
  /** Set for a fresh user turn. Absent means a resume (mid tool loop). */
  readonly userText?: string;
  readonly userMessageId?: string;
  readonly modelId: string;
  readonly conversationId: string;
  readonly tools: readonly CursorTool[];
}

export function encodeRunRequest(request: CursorRunRequest): Uint8Array {
  const state = concat(
    ...request.rootPromptMessagesJson.map((id) => encodeBytes(1, id)),
  );
  const action = request.userText !== undefined && request.userText.trim() !== ""
    ? encodeMessage(1, encodeMessage(1, concat(
        encodeString(1, request.userText),
        ...(request.userMessageId ? [encodeString(2, request.userMessageId)] : []),
      )))
    : encodeMessage(2, new Uint8Array());
  const model = concat(
    encodeString(1, request.modelId),
    encodeString(3, request.modelId),
    encodeString(4, request.modelId),
  );
  const tools = request.tools.map((tool) => encodeMessage(1, concat(
    encodeString(1, tool.name),
    encodeString(2, tool.description),
    encodeString(6, tool.inputSchemaJson),
  )));
  // Fields must be emitted in ascending number order. Cursor's backend
  // rejects an out-of-order message with `illegal tag` rather than skipping
  // the field, so the order here is load-bearing, not cosmetic.
  return concat(
    encodeMessage(1, state),
    encodeMessage(2, action),
    encodeMessage(3, model),
    ...(tools.length > 0 ? [encodeMessage(4, concat(...tools))] : []),
    encodeString(5, request.conversationId),
    encodeMessage(9, encodeString(1, request.modelId)),
  );
}

export function encodeGetBlobResult(id: number, data: Uint8Array | undefined): Uint8Array {
  const result = data === undefined ? new Uint8Array() : encodeBytes(1, data);
  return encodeMessage(3, concat(encodeVarintField(1, id), encodeMessage(2, result)));
}

export function encodeSetBlobResult(id: number): Uint8Array {
  return encodeMessage(3, concat(encodeVarintField(1, id), encodeMessage(3, new Uint8Array())));
}

export interface CursorRequestContext {
  readonly tools: readonly CursorTool[];
  /** Cursor gates its own web search on this flag inside the request context. */
  readonly webSearchEnabled: boolean;
}

export function encodeRequestContextResult(id: number, execId: string | undefined, context: CursorRequestContext): Uint8Array {
  const tools = context.tools.map((tool) => encodeMessage(7, concat(
    encodeString(1, tool.name),
    encodeString(2, tool.description),
    encodeString(6, tool.inputSchemaJson),
  )));
  const env = concat(
    encodeString(1, "linux"),
    encodeString(3, "bash"),
    encodeVarintField(5, 0),
    encodeString(10, "UTC"),
  );
  const body = concat(
    encodeMessage(4, env),
    ...tools,
    ...(context.webSearchEnabled ? [encodeVarintField(17, 1)] : []),
  );
  const success = encodeMessage(1, encodeMessage(1, body));
  return encodeMessage(2, concat(
    encodeVarintField(1, id),
    ...(execId !== undefined ? [encodeString(15, execId)] : []),
    encodeMessage(10, success),
  ));
}

export interface CursorToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: ReadonlyMap<string, Uint8Array>;
}

export type CursorServerEvent =
  | { readonly type: "get_blob"; readonly id: number; readonly blobId: Uint8Array }
  | { readonly type: "set_blob"; readonly id: number; readonly blobId: Uint8Array; readonly blobData: Uint8Array }
  | { readonly type: "request_context"; readonly id: number; readonly execId: string | undefined }
  | { readonly type: "tool_call"; readonly call: CursorToolCall }
  | { readonly type: "native_tool"; readonly name: string; readonly detail: string }
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "thinking"; readonly delta: string }
  | { readonly type: "usage"; readonly tokens: number }
  | { readonly type: "turn_ended"; readonly usage: CursorTurnUsage }
  | { readonly type: "ignored" };

/** Read one `AgentServerMessage`. Unknown branches come back as `ignored`. */
export function decodeServerMessage(bytes: Uint8Array): CursorServerEvent {
  const fields = decodeMessage(bytes);
  const interaction = firstBytes(fields, 1);
  if (interaction) return decodeInteraction(decodeMessage(interaction));
  const exec = firstBytes(fields, 2);
  if (exec) return decodeExec(decodeMessage(exec));
  const kv = firstBytes(fields, 4);
  if (kv) return decodeKv(decodeMessage(kv));
  return { type: "ignored" };
}

function decodeInteraction(fields: WireFields): CursorServerEvent {
  const text = firstBytes(fields, 1);
  if (text) return { type: "text", delta: firstString(decodeMessage(text), 1) ?? "" };
  const thinking = firstBytes(fields, 4);
  if (thinking) return { type: "thinking", delta: firstString(decodeMessage(thinking), 1) ?? "" };
  const tokens = firstBytes(fields, 8);
  if (tokens) return { type: "usage", tokens: firstVarint(decodeMessage(tokens), 1) ?? 0 };
  const ended = firstBytes(fields, 14);
  if (ended !== undefined) return { type: "turn_ended", usage: decodeTurnUsage(decodeMessage(ended)) };
  return { type: "ignored" };
}

function decodeExec(fields: WireFields): CursorServerEvent {
  const id = firstVarint(fields, 1) ?? 0;
  const execId = firstString(fields, 15);
  if (firstBytes(fields, 10) !== undefined) return { type: "request_context", id, execId };
  const webSearch = firstBytes(fields, 20);
  if (webSearch) {
    const args = decodeMessage(firstBytes(decodeMessage(webSearch), 1) ?? new Uint8Array());
    return { type: "native_tool", name: "web_search", detail: firstString(args, 1) ?? "" };
  }
  const mcp = firstBytes(fields, 11);
  if (mcp) {
    const args = decodeMessage(mcp);
    return {
      type: "tool_call",
      call: {
        id: firstString(args, 3) ?? "",
        name: firstString(args, 1) ?? firstString(args, 5) ?? "unknown",
        args: decodeBytesMap(args, 2),
      },
    };
  }
  return { type: "ignored" };
}

function decodeTurnUsage(fields: WireFields): CursorTurnUsage {
  // int64 fields. A counter the frame omits stays undefined; one it reports,
  // even as zero, is kept.
  const read = (field: number): number | undefined => {
    const value = firstVarint(fields, field);
    return value === undefined ? undefined : value;
  };
  return {
    inputTokens: read(1),
    outputTokens: read(2),
    cacheReadTokens: read(3),
    cacheWriteTokens: read(4),
    reasoningTokens: read(5),
  };
}

function decodeKv(fields: WireFields): CursorServerEvent {
  const id = firstVarint(fields, 1) ?? 0;
  const get = firstBytes(fields, 2);
  if (get) return { type: "get_blob", id, blobId: firstBytes(decodeMessage(get), 1) ?? new Uint8Array() };
  const set = firstBytes(fields, 3);
  if (set) {
    const decoded = decodeMessage(set);
    return {
      type: "set_blob",
      id,
      blobId: firstBytes(decoded, 1) ?? new Uint8Array(),
      blobData: firstBytes(decoded, 2) ?? new Uint8Array(),
    };
  }
  return { type: "ignored" };
}

/**
 * The authoritative per-turn counters Cursor sends on `TurnEndedUpdate`.
 *
 * `inputTokens` counts the whole prompt, cache hits and writes included, so
 * fresh input is what remains after both are taken out. A counter the frame
 * does not report stays undefined rather than zero, because zero would
 * overwrite the streamed estimate with a number Cursor never stated.
 */
export interface CursorTurnUsage {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
}

export interface CursorModel {
  readonly modelId: string;
}

/** `GetUsableModels` takes an empty body and returns repeated model details. */
export function decodeUsableModels(bytes: Uint8Array): readonly CursorModel[] {
  return allBytes(decodeMessage(bytes), 1).flatMap((entry) => {
    const modelId = firstString(decodeMessage(entry), 1);
    return modelId ? [{ modelId }] : [];
  });
}
