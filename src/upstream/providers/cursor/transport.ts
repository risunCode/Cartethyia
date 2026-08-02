/**
 * Cursor CLI provider transport — gRPC Connect protocol over HTTP/2
 * to Cursor's AgentService.Run endpoint.
 *
 * Pattern mirrors `devin/transport.ts`: build a protobuf request from
 * an OpenAI Chat-shaped body, stream the framed response back as
 * canonical `StreamEvent` entries.
 *
 * Auth: Cursor OAuth access token (stored as the provider credential).
 * No machine-id or checksum needed for CLI — those are IDE-only anti-
 * automation measures.
 */

import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import http2 from "node:http2";
import { ProviderCallError } from "../index";
import { flattenMessageText } from "../../../shared/text-utils";
import type { StreamEvent } from "../../bridge";
import type { OpenAIChatMessage } from "../../../translate/types";
import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  type AgentServerMessage,
  type InteractionUpdate,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  AgentConversationTurnStructureSchema,
  AssistantMessageSchema,
  ModelDetailsSchema,
  RequestedModelSchema,
  ResumeActionSchema,
  UserMessageSchema,
  UserMessageActionSchema,
} from "./generated/agent_pb";

// ── Constants ────────────────────────────────────────────────────────────

const CURSOR_BASE_URL = "https://api2.cursor.sh";
const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";
const CONNECT_FRAME_HEADER_SIZE = 5;
const END_STREAM_FLAG = 0x02;
const FRAME_TIMEOUT_MS = 120_000;

// ── Types ────────────────────────────────────────────────────────────────

export interface CursorChatRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function deterministicUuid(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  return `${hex}-${hex.slice(0, 4)}-4${hex.slice(1, 4)}-a${hex.slice(0, 3)}-${hex}${hex.slice(0, 4)}`;
}


/** Builds the Connect-protocol HTTP/2 headers for a Cursor AgentService call. */
function buildCursorHeaders(accessToken: string): Record<string, string> {
  return {
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    accept: "application/connect+proto",
    authorization: `Bearer ${accessToken}`,
    "x-cursor-client-version": CURSOR_CLIENT_VERSION,
    "user-agent": `cartethyia/${CURSOR_CLIENT_VERSION}`,
  };
}

/** Wraps a protobuf payload in a Connect protocol frame (5-byte header + payload). */
function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(CONNECT_FRAME_HEADER_SIZE + data.length);
  frame[0] = flags;
  frame.writeUInt32BE(data.length, 1);
  frame.set(data, CONNECT_FRAME_HEADER_SIZE);
  return frame;
}

/** Reads one Connect frame from a buffer. Returns the frame payload + new offset, or null if incomplete. */
function readConnectFrame(buffer: Uint8Array, offset: number, end = buffer.length): { flags: number; payload: Uint8Array; newOffset: number } | null {
  if (offset + CONNECT_FRAME_HEADER_SIZE > end) return null;
  const flags = buffer[offset]!;
  const length = ((buffer[offset + 1]! << 24) | (buffer[offset + 2]! << 16) | (buffer[offset + 3]! << 8) | buffer[offset + 4]!) >>> 0;
  if (offset + CONNECT_FRAME_HEADER_SIZE + length > end) return null;
  const payload = buffer.subarray(offset + CONNECT_FRAME_HEADER_SIZE, offset + CONNECT_FRAME_HEADER_SIZE + length);
  return { flags, payload, newOffset: offset + CONNECT_FRAME_HEADER_SIZE + length };
}

// ── Request builder ──────────────────────────────────────────────────────

/**
 * Builds a Cursor AgentRunRequest from an OpenAI Chat-shaped body.
 *
 * Cursor's conversation model: `ConversationStateStructure.turns` is an
 * array of serialized `ConversationTurnStructure` blobs. Each turn wraps
 * an `AgentConversationTurnStructure` which holds a serialized
 * `UserMessage` (bytes) and `steps[]` (assistant/tool/thinking steps).
 *
 * `ConversationStep.message` oneof only supports `assistantMessage`,
 * `toolCall`, `thinkingMessage` — user messages go in the turn's
 * `userMessage` bytes field, not in `steps[]`.
 */
export function buildCursorChatRequest(
  accessToken: string,
  modelId: string,
  body: Record<string, unknown>,
): CursorChatRequest {
  const messages = Array.isArray(body.messages) ? (body.messages as OpenAIChatMessage[]) : [];

  // Build conversation turns from history (all messages except the last user message)
  const turns: Uint8Array[] = [];
  let currentSteps: ReturnType<typeof create<typeof ConversationStepSchema>>[] = [];
  let currentUserMessageBytes: Uint8Array | undefined;

  for (let i = 0; i < messages.length - 1; i++) {
    const msg = messages[i]!;
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      // Flush previous turn if we have one
      if (currentUserMessageBytes || currentSteps.length > 0) {
        const agentTurn = create(AgentConversationTurnStructureSchema, {
          userMessage: currentUserMessageBytes ?? new Uint8Array(),
          steps: currentSteps.map((s) => toBinary(ConversationStepSchema, s)),
        });
        const turn = create(ConversationTurnStructureSchema, {
          turn: { case: "agentConversationTurn", value: agentTurn },
        });
        turns.push(toBinary(ConversationTurnStructureSchema, turn));
        currentSteps = [];
      }
      // Serialize user message to bytes using proper schema
      currentUserMessageBytes = toBinary(UserMessageSchema, create(UserMessageSchema, { text: flattenMessageText(msg.content) }));
    } else if (msg.role === "assistant") {
      currentSteps.push(
        create(ConversationStepSchema, {
          message: {
            case: "assistantMessage",
            value: create(AssistantMessageSchema, { text: flattenMessageText(msg.content) }),
          },
        }),
      );
    }
    // tool messages are skipped — Cursor handles tool execution server-side
  }

  // Flush the last turn
  if (currentUserMessageBytes || currentSteps.length > 0) {
    const agentTurn = create(AgentConversationTurnStructureSchema, {
      userMessage: currentUserMessageBytes ?? new Uint8Array(),
      steps: currentSteps.map((s) => toBinary(ConversationStepSchema, s)),
    });
    const turn = create(ConversationTurnStructureSchema, {
      turn: { case: "agentConversationTurn", value: agentTurn },
    });
    turns.push(toBinary(ConversationTurnStructureSchema, turn));
  }

  // System prompt as custom system prompt
  const systemMessages = messages.filter((m) => m.role === "system");
  const systemPromptText = systemMessages.map((m) => flattenMessageText(m.content)).join("\n\n");

  // Active user message (last message)
  const lastMsg = messages[messages.length - 1];
  const userText = lastMsg ? flattenMessageText(lastMsg.content) : "";

  const conversationState = create(ConversationStateStructureSchema, {
    turns,
    todos: [],
    pendingToolCalls: [],
    previousWorkspaceUris: [],
    fileStates: {},
    fileStatesV2: {},
    summaryArchives: [],
    turnTimings: [],
    subagentStates: {},
    selfSummaryCount: 0,
    readPaths: [],
  });

  const action = create(ConversationActionSchema, {
    action: userText.trim()
      ? {
          case: "userMessageAction",
          value: create(UserMessageActionSchema, {
            userMessage: create(UserMessageSchema, { text: userText }),
          }),
        }
      : { case: "resumeAction", value: create(ResumeActionSchema, {}) },
  });

  const modelDetails = create(ModelDetailsSchema, { modelId, displayModelId: modelId, displayName: modelId });
  const requestedModel = create(RequestedModelSchema, { modelId });

  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails,
    requestedModel,
    conversationId: deterministicUuid(`cartethyia-${Date.now()}`),
  });

  if (systemPromptText) runRequest.customSystemPrompt = systemPromptText;

  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: runRequest },
  });

  return {
    url: `${CURSOR_BASE_URL}${CURSOR_RUN_PATH}`,
    headers: buildCursorHeaders(accessToken),
    body: toBinary(AgentClientMessageSchema, clientMessage),
  };
}

// ── Response decoder ─────────────────────────────────────────────────────

function extractToolName(toolCall: { tool?: { case?: string } } | undefined): string {
  if (!toolCall?.tool?.case) return "unknown";
  // Map proto tool case to friendly name
  const caseMap: Record<string, string> = {
    shellToolCall: "bash", readToolCall: "read", writeToolCall: "write",
    deleteToolCall: "delete", editToolCall: "edit", lsToolCall: "ls",
    grepToolCall: "grep", globToolCall: "glob", mcpToolCall: "mcp",
    updateTodosToolCall: "todo", readTodosToolCall: "todo",
    diagnosticsToolCall: "diagnostics", applyAgentDiffToolCall: "apply_diff",
    webSearchToolCall: "web_search", fetchToolCall: "fetch",
    semSearchToolCall: "sem_search", taskToolCall: "task",
    askQuestionToolCall: "ask", computerUseToolCall: "computer_use",
    createPlanToolCall: "create_plan", switchModeToolCall: "switch_mode",
    readLintsToolCall: "read_lints", generateImageToolCall: "generate_image",
  };
  return caseMap[toolCall.tool.case] ?? toolCall.tool.case;
}

function extractToolArgs(toolCall: { tool?: { value?: Record<string, unknown> } } | undefined): Record<string, unknown> {
  if (!toolCall?.tool?.value) return {};
  const value = toolCall.tool.value;
  // Most tool calls have an args field
  const args = (value as Record<string, unknown>).args;
  if (args && typeof args === "object") return args as Record<string, unknown>;
  return {};
}

/**
 * Decodes a Cursor AgentService.Run HTTP/2 response stream into canonical
 * StreamEvent entries. The stream uses Connect protocol framing (5-byte
 * header per frame) with protobuf-encoded `AgentServerMessage` payloads.
 */
export async function* decodeCursorStream(response: http2.ClientHttp2Stream): AsyncGenerator<StreamEvent> {
  let buffer = new Uint8Array(8_192);
  let bufferStart = 0;
  let bufferEnd = 0;
  let finishSeen = false;
  const toolCallArgsAccum = new Map<string, string>();

  for await (const chunk of response) {
    const required = bufferEnd + chunk.length;
    if (required > buffer.length) {
      if (bufferStart > 0) {
        buffer.copyWithin(0, bufferStart, bufferEnd);
        bufferEnd -= bufferStart;
        bufferStart = 0;
      }
      if (required > buffer.length) {
        let capacity = buffer.length;
        while (capacity < required) capacity *= 2;
        const expanded = new Uint8Array(capacity);
        expanded.set(buffer.subarray(0, bufferEnd));
        buffer = expanded;
      }
    }
    buffer.set(chunk, bufferEnd);
    bufferEnd += chunk.length;

    while (bufferEnd - bufferStart >= CONNECT_FRAME_HEADER_SIZE) {
      const frame = readConnectFrame(buffer, bufferStart, bufferEnd);
      if (!frame) break;
      bufferStart = frame.newOffset;

      // End-stream flag = trailer frame
      if ((frame.flags & END_STREAM_FLAG) !== 0) {
        try {
          const trailerText = new TextDecoder().decode(frame.payload);
          const trailer = JSON.parse(trailerText) as { error?: { code?: string; message?: string } };
          if (trailer?.error?.message) {
            throw new ProviderCallError(502, "unavailable", `Cursor stream error: ${trailer.error.code ?? "unknown"}: ${trailer.error.message}`);
          }
        } catch (err) {
          if (err instanceof ProviderCallError) throw err;
        }
        finishSeen = true;
        break;
      }

      // Decode protobuf AgentServerMessage
      let serverMsg: AgentServerMessage;
      try {
        serverMsg = fromBinary(AgentServerMessageSchema, frame.payload);
      } catch {
        continue; // Skip undecodable frames
      }

      if (serverMsg.message?.case === "interactionUpdate") {
        const update = serverMsg.message.value as InteractionUpdate;
        const updateCase = update.message?.case;

        if (updateCase === "textDelta") {
          const text = (update.message.value as { text?: string }).text || "";
          if (text) yield { type: "text_delta", text };
        } else if (updateCase === "thinkingDelta") {
          const text = (update.message.value as { text?: string }).text || "";
          if (text) yield { type: "thinking_delta", text };
        } else if (updateCase === "toolCallStarted") {
          const started = update.message.value as { callId?: string; toolCall?: { tool?: { case?: string; value?: Record<string, unknown> } } };
          const callId = started.callId || crypto.randomUUID();
          const toolName = extractToolName(started.toolCall);
          const args = extractToolArgs(started.toolCall);
          toolCallArgsAccum.set(callId, "");
          yield { type: "tool_call_start", id: callId, name: toolName };
          const argsJson = JSON.stringify(args);
          if (argsJson !== "{}") {
            toolCallArgsAccum.set(callId, argsJson);
            yield { type: "tool_call_args_delta", id: callId, argumentsDelta: argsJson };
          }
        } else if (updateCase === "toolCallDelta" || updateCase === "partialToolCall") {
          const delta = update.message.value as { callId?: string; argsTextDelta?: string };
          const callId = delta.callId || "";
          const snapshot = delta.argsTextDelta || "";
          if (callId && snapshot) {
            const current = toolCallArgsAccum.get(callId) ?? "";
            const chunk = snapshot.startsWith(current) ? snapshot.slice(current.length) : snapshot;
            if (chunk) {
              toolCallArgsAccum.set(callId, current + chunk);
              yield { type: "tool_call_args_delta", id: callId, argumentsDelta: chunk };
            }
          }
        } else if (updateCase === "toolCallCompleted") {
          const completed = update.message.value as { callId?: string };
          if (completed.callId) {
            toolCallArgsAccum.delete(completed.callId);
            yield { type: "tool_call_end", id: completed.callId };
          }
        } else if (updateCase === "turnEnded") {
          finishSeen = true;
        }
      } else if (serverMsg.message?.case === "conversationCheckpointUpdate") {
        // Conversation checkpoint — extract stop reason if available
        const checkpoint = serverMsg.message.value as Record<string, unknown>;
        if (checkpoint?.stopReason) finishSeen = true;
      } else if (serverMsg.message?.case === "execServerMessage") {
        // Exec channel message — Cartethyia doesn't execute tools locally.
        // Log and ignore; the server will timeout the exec and continue.
      }
    }

    if (bufferStart === bufferEnd) {
      bufferStart = 0;
      bufferEnd = 0;
    } else if (bufferStart > buffer.length / 2) {
      buffer.copyWithin(0, bufferStart, bufferEnd);
      bufferEnd -= bufferStart;
      bufferStart = 0;
    }
    if (finishSeen) break;
  }

  yield { type: "finish", stopReason: "end_turn" };
}

// ── HTTP/2 transport ─────────────────────────────────────────────────────

/**
 * Opens an HTTP/2 session to Cursor's AgentService and streams the
 * response. Returns a ClientHttp2Stream that yields Connect-framed
 * protobuf AgentServerMessage chunks.
 */
export async function openCursorHttp2Stream(
  request: CursorChatRequest,
  signal: AbortSignal,
): Promise<http2.ClientHttp2Stream> {
  const url = new URL(request.url);
  const session = http2.connect(url.origin);

  signal.addEventListener("abort", () => session.close());

  const reqStream = session.request({
    ":method": "POST",
    ":path": url.pathname,
    ":authority": url.host,
    ...request.headers,
  });

  // Connect protocol: the request envelope carries the plain message
  // (flags=0). END_STREAM_FLAG only marks the server's trailer frame in the
  // *response* stream — setting it here made Cursor treat our protobuf
  // payload as an EndStreamResponse-shaped trailer and discard the actual
  // message, surfacing as "invalid_argument: Request is empty". Ending the
  // request stream is the HTTP/2-level `reqStream.end()` below, not a flag.
  reqStream.write(frameConnectMessage(request.body));
  reqStream.end();

  return new Promise<http2.ClientHttp2Stream>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reqStream.close();
      session.close();
      reject(new ProviderCallError(504, "unavailable", "Cursor HTTP/2 stream timed out."));
    }, FRAME_TIMEOUT_MS);

    reqStream.on("response", (headers) => {
      clearTimeout(timeout);
      const status = Number(headers[":status"] || 0);
      if (status >= 400) {
        const chunks: Buffer[] = [];
        reqStream.on("data", (chunk: Buffer) => chunks.push(chunk));
        reqStream.on("end", () => {
          session.close();
          const body = Buffer.concat(chunks).toString("utf-8");
          const kind = status === 401 || status === 403 ? "authentication" : status === 429 ? "rate_limited" : "unavailable";
          reject(new ProviderCallError(status, kind, `Cursor API error ${status}: ${body.slice(0, 500)}`));
        });
        return;
      }
      resolve(reqStream);
    });

    reqStream.on("error", (err) => {
      clearTimeout(timeout);
      session.close();
      reject(new ProviderCallError(502, "unavailable", `Cursor HTTP/2 error: ${err.message}`));
    });
  });
}
