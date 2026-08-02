/**
 * POST /v1/chat/completions — client speaks OpenAI Chat Completions.
 * Every model routes through the provider registry (`dispatchQualifiedRoute`);
 * a bare, unqualified model name is rejected rather than falling back to a
 * direct OpenAI/Anthropic upstream call.
 */

import { Elysia } from "elysia";
import { ChatRequestSchema } from "./schemas";
import { encodeOpenAIChatStream } from "../upstream/bridge";
import { openAIClientError, openAIUpstreamError } from "../http/errors";
import type { OpenAIChatRequest } from "../translate/types";
import { dispatchQualifiedRoute } from "../upstream/dispatch";
import { withProxyRequest } from "./middleware/proxyRequest";
import { finishSurfaceDispatch } from "./dispatch-surface";

export const chatRoute = new Elysia().post(
  "/v1/chat/completions",
  async ({ body, headers: rawHeaders, set, request, server }) => {
    const req = body as OpenAIChatRequest;
    const headers = rawHeaders as Record<string, string | undefined>;

    return withProxyRequest(
      { endpoint: "/v1/chat/completions", surface: "chat", model: req.model, stream: req.stream === true, request, server, set, errorMapper: openAIUpstreamError },
      async ({ tracker, recordRequestBody }) => {
        recordRequestBody(req);

        const qualified = await dispatchQualifiedRoute({
          model: req.model,
          body: req as Record<string, unknown>,
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
          clientError: openAIClientError,
          streamFormat: "openai-chat",
          encodeStream: encodeOpenAIChatStream,
          idPrefix: "chatcmpl",
          model: req.model,
          toSurfaceJson: (body) => body,
        });
      },
    );
  },
  { body: ChatRequestSchema },
);
