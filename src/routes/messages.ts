/**
 * POST /v1/messages — client speaks Anthropic Messages.
 * Routes to Anthropic or OpenAI upstream by model name.
 */

import { Elysia } from "elysia";
import { MessagesRequestSchema } from "./schemas";
import { selectProvider, resolveOpenAIAuth, resolveAnthropicAuth, callMessages, callChatCompletions, UpstreamError } from "../upstream/providers";
import { translateMessagesRequestToChat, translateChatResponseToMessages } from "../translate/openai-anthropic";
import { decodeOpenAIChatStream, encodeAnthropicStream } from "../upstream/bridge";
import { toSSEResponseStream } from "../upstream/sse";
import { asObject } from "../upstream/jsonGuards";
import { anthropicClientError, anthropicUpstreamError } from "../http/errors";
import type { AnthropicRequest, OpenAIChatResponse } from "../translate/types";

export const messagesRoute = new Elysia().post(
  "/v1/messages",
  async ({ body, headers, set }) => {
    const req = body as AnthropicRequest;
    const provider = selectProvider(req.model);
    const isStreaming = req.stream === true;

    try {
      if (provider === "anthropic") {
        const auth = resolveAnthropicAuth(headers);
        const res = await callMessages(req, { apiKeyHeader: auth });
        if (isStreaming) {
          set.headers["content-type"] = "text/event-stream";
          return res.body ?? new ReadableStream();
        }
        return await res.json();
      }

      // OpenAI upstream, Anthropic-shape client.
      const chatReq = translateMessagesRequestToChat(req);
      const auth = resolveOpenAIAuth(headers);
      const res = await callChatCompletions(chatReq, { authorizationHeader: auth });

      if (isStreaming) {
        set.headers["content-type"] = "text/event-stream";
        const meta = { id: `msg-${crypto.randomUUID()}`, model: req.model, createdAt: Math.floor(Date.now() / 1000) };
        const events = decodeOpenAIChatStream(res.body ?? new ReadableStream());
        return toSSEResponseStream(encodeAnthropicStream(events, meta));
      }

      const parsedBody = asObject(await res.json());
      if (!parsedBody) {
        set.status = 502;
        return anthropicClientError(502, "internal_error", "The provider answered, but its response was incomplete or unreadable. Please retry this request in a moment.");
      }
      const chatBody = parsedBody as unknown as OpenAIChatResponse;
      return translateChatResponseToMessages(chatBody);
    } catch (err) {
      if (err instanceof UpstreamError) {
        const friendly = anthropicUpstreamError(err);
        set.status = friendly.status;
        return friendly.body;
      }
      throw err;
    }
  },
  { body: MessagesRequestSchema }
);
