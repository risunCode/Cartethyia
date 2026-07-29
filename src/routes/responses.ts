/**
 * POST /v1/responses — client speaks OpenAI Responses.
 * Routes to OpenAI (Responses natively) or Anthropic (via Chat Completions
 * shape as the intermediate, since Anthropic has no Responses-equivalent
 * surface) by model name.
 */

import { Elysia } from "elysia";
import { ResponsesRequestSchema } from "./schemas";
import { selectProvider, resolveOpenAIAuth, resolveAnthropicAuth, callResponses, callMessages } from "../upstream/providers";
import { translateResponsesRequestToChat, translateChatResponseToResponses } from "../translate/openai-responses";
import { translateChatRequestToAnthropic, translateAnthropicResponseToChat } from "../translate/openai-anthropic";
import { decodeAnthropicStream, encodeResponsesStream, withStreamErrorHandling } from "../upstream/bridge";
import { toSSEResponseStream } from "../upstream/sse";
import { asObject } from "../upstream/jsonGuards";
import { openAIClientError, openAIUpstreamError } from "../http/errors";
import type { AnthropicResponse, OpenAIResponsesRequest } from "../translate/types";
import { dispatchQualifiedRoute } from "../upstream/dispatch";
import { withProxyRequest } from "./middleware/proxyRequest";

export const responsesRoute = new Elysia().post(
  "/v1/responses",
  async ({ body, headers: rawHeaders, set, request, server }) => {
    const req = body as OpenAIResponsesRequest;
    const provider = selectProvider(req.model);
    const isStreaming = req.stream === true;
    const headers = rawHeaders as Record<string, string | undefined>;

    return withProxyRequest(
      { endpoint: "/v1/responses", surface: "responses", model: req.model, stream: isStreaming, request, server, set, errorMapper: openAIUpstreamError },
      async ({ tracker, recordRequestBody }) => {
        recordRequestBody(req);

        const chatReq = translateResponsesRequestToChat(req);
        const qualified = await dispatchQualifiedRoute({
          model: req.model,
          body: chatReq as unknown as Record<string, unknown>,
          headers,
          request,
          surface: "openai-chat",
        });
        if (qualified.kind === "error") {
          set.status = qualified.status;
          tracker.fail(qualified.status, "dispatch_error", req);
          return openAIClientError(qualified.status, qualified.status === 401 || qualified.status === 403 ? "authentication_error" : "invalid_request_error", qualified.message);
        }
        if (qualified.kind === "result") {
          if (qualified.proxyPoolName) tracker.setProxyPool(qualified.proxyPoolName);
          if (qualified.result.type === "stream") {
            set.headers["content-type"] = "text/event-stream";
            const meta = { id: `resp-${crypto.randomUUID()}`, model: req.model, createdAt: Math.floor(Date.now() / 1000) };
            return tracker.wrapSse(toSSEResponseStream(withStreamErrorHandling(encodeResponsesStream(qualified.result.events, meta), "openai-responses")), undefined, req);
          }
          return tracker.finishJson(200, translateChatResponseToResponses(qualified.result.body as never), undefined, req);
        }

        if (provider === "openai") {
          const auth = resolveOpenAIAuth(headers);
          const res = await callResponses(req, { authorizationHeader: auth });
          if (isStreaming) {
            set.headers["content-type"] = "text/event-stream";
            return tracker.wrapSse(res.body ?? new ReadableStream(), undefined, req);
          }
          return tracker.finishJson(200, await res.json(), undefined, req);
        }

        // Anthropic upstream, Responses-shape client: Responses → Chat → Anthropic.
        const anthropicReq = translateChatRequestToAnthropic(chatReq);
        const auth = resolveAnthropicAuth(headers);
        const res = await callMessages(anthropicReq, { apiKeyHeader: auth });

        if (isStreaming) {
          set.headers["content-type"] = "text/event-stream";
          const meta = { id: `resp-${crypto.randomUUID()}`, model: req.model, createdAt: Math.floor(Date.now() / 1000) };
          const events = decodeAnthropicStream(res.body ?? new ReadableStream());
          return tracker.wrapSse(toSSEResponseStream(withStreamErrorHandling(encodeResponsesStream(events, meta), "openai-responses")), undefined, req);
        }

        const parsedBody = asObject(await res.json());
        if (!parsedBody) {
          set.status = 502;
          tracker.fail(502, "internal_error", req);
          return openAIClientError(502, "internal_error", "The provider answered, but its response was incomplete or unreadable. Please retry this request in a moment.");
        }
        const anthropicBody = parsedBody as unknown as AnthropicResponse;
        const chatResp = translateAnthropicResponseToChat(anthropicBody);
        return tracker.finishJson(200, translateChatResponseToResponses(chatResp), undefined, req);
      },
    );
  },
  { body: ResponsesRequestSchema },
);
