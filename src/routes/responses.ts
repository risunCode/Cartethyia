/**
 * POST /v1/responses — client speaks OpenAI Responses.
 * Routes to OpenAI (Responses natively) or Anthropic (via Chat Completions
 * shape as the intermediate, since Anthropic has no Responses-equivalent
 * surface) by model name.
 */

import { Elysia } from "elysia";
import { ResponsesRequestSchema } from "./schemas";
import { translateResponsesRequestToChat, translateChatResponseToResponses } from "../translate/openai-responses";
import { encodeResponsesStream, withStreamErrorHandling } from "../upstream/bridge";
import { toSSEResponseStream } from "../upstream/sse";
import { openAIClientError, openAIUpstreamError } from "../http/errors";
import type { OpenAIResponsesRequest } from "../translate/types";
import { dispatchQualifiedRoute } from "../upstream/dispatch";
import { withProxyRequest } from "./middleware/proxyRequest";

export const responsesRoute = new Elysia().post(
  "/v1/responses",
  async ({ body, headers: rawHeaders, set, request, server }) => {
    const req = body as OpenAIResponsesRequest;
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
      },
    );
  },
  { body: ResponsesRequestSchema },
);
