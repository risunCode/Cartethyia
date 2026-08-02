/**
 * POST /v1/messages — client speaks Anthropic Messages.
 * Routes to Anthropic or OpenAI upstream by model name.
 * Supports context_management compact edits (REQ-23, compact-2026-01-12).
 */

import { Elysia } from "elysia";
import { MessagesRequestSchema } from "./schemas";
import { translateMessagesRequestToChat, translateChatResponseToMessages } from "../translate/openai-anthropic";
import { encodeAnthropicStream } from "../upstream/bridge";
import { toSSEResponseStream, formatSSEFrame } from "../upstream/sse";
import { anthropicClientError, anthropicUpstreamError } from "../http/errors";
import type { AnthropicRequest, AnthropicResponse, OpenAIChatResponse } from "../translate/types";
import { dispatchQualifiedRoute } from "../upstream/dispatch";
import { withProxyRequest } from "./middleware/proxyRequest";
import { runEmulatedCompact, CompactError } from "./compact-core";
import { finishSurfaceDispatch } from "./dispatch-surface";

// ── Compaction helpers (REQ-23, §10.3) ────────────────────────────────────

interface CompactEdit {
  trigger?: { type: string; value?: number };
  instructions?: string;
  pause_after_compaction?: boolean;
}

function parseCompactEdits(req: AnthropicRequest): CompactEdit[] {
  const cm = (req as Record<string, unknown>)["context_management"];
  if (!cm || typeof cm !== "object") return [];
  const edits = (cm as Record<string, unknown>)["edits"];
  if (!Array.isArray(edits)) return [];
  return edits.filter(
    (e): e is Record<string, unknown> =>
      typeof e === "object" && e !== null && typeof (e as Record<string, unknown>).type === "string" && /^compact_/.test((e as Record<string, unknown>).type as string),
  ) as unknown as CompactEdit[];
}

function buildCompactionResponse(model: string, summaryText: string, pause: boolean): AnthropicResponse {
  return {
    id: `msg-compact-${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: `[Compacted]\n\n${summaryText}` }],
    stop_reason: pause ? "pause_turn" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

async function* buildCompactionSSE(model: string, summaryText: string, pause: boolean): AsyncGenerator<string> {
  const msgId = `msg-compact-${crypto.randomUUID()}`;
  yield formatSSEFrame({
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    }),
  });

  // Summary content block: server_tool_use with summary type (Anthropic compact protocol)
  yield formatSSEFrame({
    event: "content_block_start",
    data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: `compact-${crypto.randomUUID()}`, name: "summary", input: {} } }),
  });

  // Send summary text in chunks to avoid oversized frames
  const CHUNK = 4096;
  for (let offset = 0; offset < summaryText.length; offset += CHUNK) {
    yield formatSSEFrame({
      event: "content_block_delta",
      data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(summaryText.slice(offset, offset + CHUNK)).slice(1, -1) } }),
    });
  }

  yield formatSSEFrame({
    event: "content_block_stop",
    data: JSON.stringify({ type: "content_block_stop", index: 0 }),
  });

  yield formatSSEFrame({
    event: "message_delta",
    data: JSON.stringify({ type: "message_delta", delta: { stop_reason: pause ? "pause_turn" : "end_turn", stop_sequence: null }, usage: {} }),
  });

  yield formatSSEFrame({
    event: "message_stop",
    data: JSON.stringify({ type: "message_stop" }),
  });
}

// ── Main route ────────────────────────────────────────────────────────────

export const messagesRoute = new Elysia().post(
  "/v1/messages",
  async ({ body, headers, set, request, server }) => {
    const req = body as AnthropicRequest;
    const isStreaming = req.stream === true;

    return withProxyRequest(
      { endpoint: "/v1/messages", surface: "anthropic", model: req.model, stream: isStreaming, request, server, set, errorMapper: anthropicUpstreamError },
      async ({ tracker, recordRequestBody }) => {
        recordRequestBody(req);

        // Standard dispatch path - shared by the plain (no compact-edit) flow
        // AND the compact-edit "trigger not yet met" fallthrough, which only
        // differs in which (possibly context_management-stripped) request gets
        // translated and dispatched.
        const dispatchStandard = async (anthropicReq: AnthropicRequest) => {
          const chatReq = translateMessagesRequestToChat(anthropicReq);
          const qualified = await dispatchQualifiedRoute({
            model: req.model,
            body: chatReq as unknown as Record<string, unknown>,
            headers,
            request,
            clientIp: server?.requestIP(request)?.address,
            surface: "openai-chat",
          });
          return finishSurfaceDispatch({
            qualified,
            set,
            tracker,
            requestBody: req,
            clientError: anthropicClientError,
            streamFormat: "anthropic",
            encodeStream: encodeAnthropicStream,
            idPrefix: "msg",
            model: req.model,
            toSurfaceJson: (body) => translateChatResponseToMessages(body as unknown as OpenAIChatResponse),
          });
        };

        try {
          // ── Compaction detection (REQ-23) ──
          const compactEdits = parseCompactEdits(req);
          if (compactEdits.length > 0) {
            const edit = compactEdits[0]!;
            const trigger = edit.trigger;
            const hasTrigger = trigger && typeof trigger.value === "number" && trigger.value > 0;

            // Estimate input tokens (chars / 4) to check trigger
            const msgChars = JSON.stringify(req.messages).length;
            const estimatedTokens = Math.floor(msgChars / 4);

            if (hasTrigger && estimatedTokens < trigger!.value!) {
              // Trigger not yet met — strip context_management and dispatch normally
              const stripped = { ...req } as Record<string, unknown>;
              delete stripped["context_management"];
              return dispatchStandard(stripped as unknown as AnthropicRequest);
            }

            // Trigger met or no trigger — run emulated compaction
            const chatReq = translateMessagesRequestToChat(req);
            const { text: summaryText } = await runEmulatedCompact({
              model: req.model,
              chatReq,
              headers,
              request,
              instruction: edit.instructions,
            });

            const pause = edit.pause_after_compaction === true;

            if (isStreaming) {
              set.headers["content-type"] = "text/event-stream";
              return tracker.wrapSse(toSSEResponseStream(buildCompactionSSE(req.model, summaryText, pause)), undefined, req);
            }

            const result = buildCompactionResponse(req.model, summaryText, pause);
            return tracker.finishJson(200, result, undefined, req);
          }
        } catch (err) {
          if (err instanceof CompactError) {
            set.status = err.status;
            tracker.fail(err.status, "compact_error", req);
            return anthropicClientError(err.status, err.status === 401 || err.status === 403 ? "authentication_error" : "invalid_request_error", err.message);
          }
          throw err;
        }

        // ── Standard message flow (no compact edit present) ──
        return dispatchStandard(req);
      },
    );
  },
  { body: MessagesRequestSchema },
);
