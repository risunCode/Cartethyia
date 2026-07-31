/**
 * POST /v1/responses — client speaks OpenAI Responses.
 * Routes to OpenAI (Responses natively) or Anthropic (via Chat Completions
 * shape as the intermediate, since Anthropic has no Responses-equivalent
 * surface) by model name.
 */

import { Elysia } from "elysia";
import { ResponsesRequestSchema } from "./schemas";
import { translateResponsesRequestToChat, translateChatResponseToResponses } from "../translate/openai-responses";
import { encodeResponsesStream } from "../upstream/bridge";
import { openAIClientError, openAIUpstreamError } from "../http/errors";
import type { OpenAIResponsesRequest } from "../translate/types";
import { dispatchQualifiedRoute } from "../upstream/dispatch";
import { withProxyRequest } from "./middleware/proxyRequest";
import { finishSurfaceDispatch } from "./dispatch-surface";

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
        return finishSurfaceDispatch({
          qualified,
          set,
          tracker,
          requestBody: req,
          clientError: openAIClientError,
          streamFormat: "openai-responses",
          encodeStream: encodeResponsesStream,
          idPrefix: "resp",
          model: req.model,
          toSurfaceJson: (body) => translateChatResponseToResponses(body as never),
        });
      },
    );
  },
  { body: ResponsesRequestSchema },
);
