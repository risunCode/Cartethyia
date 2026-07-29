/**
 * POST /v1/chat/completions — client speaks OpenAI Chat Completions.
 * Routes legacy model names to OpenAI or Anthropic upstream by model name,
 * and provider-qualified models to the new provider registry.
 */

import { Elysia } from "elysia";
import { ChatRequestSchema } from "./schemas";
import { encodeOpenAIChatStream, withStreamErrorHandling } from "../upstream/bridge";
import { toSSEResponseStream } from "../upstream/sse";
import { openAIClientError, openAIUpstreamError } from "../http/errors";
import type { OpenAIChatRequest } from "../translate/types";
import { dispatchQualifiedRoute } from "../upstream/dispatch";
import { withProxyRequest } from "./middleware/proxyRequest";

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
          surface: "openai-chat",
        });
        if (qualified.kind === "error") {
          set.status = qualified.status;
          if (qualified.status === 429 || qualified.status === 503) (set as Record<string, unknown>).headers = { ...(set as Record<string, unknown>).headers as Record<string, string>, "retry-after": "60" };
          tracker.fail(qualified.status, "dispatch_error", req);
          return openAIClientError(qualified.status, qualified.status === 401 || qualified.status === 403 ? "authentication_error" : qualified.status === 429 ? "rate_limit_error" : "invalid_request_error", qualified.message);
        }

        if (qualified.proxyPoolName) tracker.setProxyPool(qualified.proxyPoolName);
        const { result } = qualified;
        if (result.type === "stream") {
          set.headers["content-type"] = "text/event-stream";
          const meta = { id: `chatcmpl-${crypto.randomUUID()}`, model: req.model, createdAt: Math.floor(Date.now() / 1000) };
          return tracker.wrapSse(toSSEResponseStream(withStreamErrorHandling(encodeOpenAIChatStream(result.events, meta), "openai-chat")), undefined, req);
        }

        return tracker.finishJson(200, result.body, undefined, req);
      },
    );
  },
  { body: ChatRequestSchema },
);
