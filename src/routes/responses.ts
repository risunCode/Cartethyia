/**
 * POST /v1/responses — client speaks OpenAI Responses.
 * Routes to OpenAI (Responses natively) or Anthropic (via Chat Completions
 * shape as the intermediate, since Anthropic has no Responses-equivalent
 * surface) by model name.
 */

import { Elysia } from "elysia";
import { ResponsesRequestSchema } from "./schemas";
import { selectProvider, resolveOpenAIAuth, resolveAnthropicAuth, callResponses, callMessages, UpstreamError } from "../upstream/providers";
import { translateResponsesRequestToChat, translateChatResponseToResponses } from "../translate/openai-responses";
import { translateChatRequestToAnthropic, translateAnthropicResponseToChat } from "../translate/openai-anthropic";
import { decodeAnthropicStream, encodeResponsesStream } from "../upstream/bridge";
import { toSSEResponseStream } from "../upstream/sse";
import { asObject } from "../upstream/jsonGuards";
import { openAIClientError, openAIUpstreamError } from "../http/errors";
import type { AnthropicResponse, OpenAIResponsesRequest } from "../translate/types";

export const responsesRoute = new Elysia().post(
  "/v1/responses",
  async ({ body, headers, set }) => {
    const req = body as OpenAIResponsesRequest;
    const provider = selectProvider(req.model);
    const isStreaming = req.stream === true;

    try {
      if (provider === "openai") {
        const auth = resolveOpenAIAuth(headers);
        const res = await callResponses(req, { authorizationHeader: auth });
        if (isStreaming) {
          set.headers["content-type"] = "text/event-stream";
          return res.body ?? new ReadableStream();
        }
        return await res.json();
      }

      // Anthropic upstream, Responses-shape client: Responses → Chat → Anthropic.
      const chatReq = translateResponsesRequestToChat(req);
      const anthropicReq = translateChatRequestToAnthropic(chatReq);
      const auth = resolveAnthropicAuth(headers);
      const res = await callMessages(anthropicReq, { apiKeyHeader: auth });

      if (isStreaming) {
        set.headers["content-type"] = "text/event-stream";
        const meta = { id: `resp-${crypto.randomUUID()}`, model: req.model, createdAt: Math.floor(Date.now() / 1000) };
        const events = decodeAnthropicStream(res.body ?? new ReadableStream());
        return toSSEResponseStream(encodeResponsesStream(events, meta));
      }

      const parsedBody = asObject(await res.json());
      if (!parsedBody) {
        set.status = 502;
        return openAIClientError(502, "internal_error", "The provider answered, but its response was incomplete or unreadable. Please retry this request in a moment.");
      }
      const anthropicBody = parsedBody as unknown as AnthropicResponse;
      const chatResp = translateAnthropicResponseToChat(anthropicBody);
      return translateChatResponseToResponses(chatResp);
    } catch (err) {
      if (err instanceof UpstreamError) {
        const friendly = openAIUpstreamError(err);
        set.status = friendly.status;
        return friendly.body;
      }
      throw err;
    }
  },
  { body: ResponsesRequestSchema }
);
