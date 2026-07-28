/**
 * POST /v1/chat/completions — client speaks OpenAI Chat Completions.
 * Routes to OpenAI or Anthropic upstream by model name (see upstream/providers.ts).
 */

import { Elysia } from "elysia";
import { ChatRequestSchema } from "./schemas";
import { selectProvider, resolveOpenAIAuth, resolveAnthropicAuth, callChatCompletions, callMessages, UpstreamError } from "../upstream/providers";
import { translateChatRequestToAnthropic, translateAnthropicResponseToChat } from "../translate/openai-anthropic";
import { decodeAnthropicStream, encodeOpenAIChatStream } from "../upstream/bridge";
import { toSSEResponseStream } from "../upstream/sse";
import { asObject } from "../upstream/jsonGuards";
import { openAIClientError, openAIUpstreamError } from "../http/errors";
import type { AnthropicResponse, OpenAIChatRequest } from "../translate/types";

export const chatRoute = new Elysia().post(
  "/v1/chat/completions",
  async ({ body, headers, set }) => {
    // `body` was runtime-validated by ChatRequestSchema (TypeBox, at the
    // route boundary) for `model`/`messages`; the wider OpenAIChatRequest
    // shape below is read field-by-field with optional chaining downstream
    // (translate/types.ts's `[key: string]: unknown` catch-all), so no
    // field here is ever trusted un-narrowed past what schema already checked.
    const req = body as OpenAIChatRequest;
    const provider = selectProvider(req.model);
    const isStreaming = req.stream === true;

    try {
      if (provider === "openai") {
        const auth = resolveOpenAIAuth(headers);
        const res = await callChatCompletions(req, { authorizationHeader: auth });
        if (isStreaming) {
          set.headers["content-type"] = "text/event-stream";
          return res.body ?? new ReadableStream();
        }
        return await res.json();
      }

      // Anthropic upstream, OpenAI-shape client.
      const anthropicReq = translateChatRequestToAnthropic(req);
      const auth = resolveAnthropicAuth(headers);
      const res = await callMessages(anthropicReq, { apiKeyHeader: auth });

      if (isStreaming) {
        set.headers["content-type"] = "text/event-stream";
        const meta = { id: `chatcmpl-${crypto.randomUUID()}`, model: req.model, createdAt: Math.floor(Date.now() / 1000) };
        const events = decodeAnthropicStream(res.body ?? new ReadableStream());
        return toSSEResponseStream(encodeOpenAIChatStream(events, meta));
      }

      const parsedBody = asObject(await res.json());
      if (!parsedBody) {
        set.status = 502;
        return openAIClientError(502, "internal_error", "The provider answered, but its response was incomplete or unreadable. Please retry this request in a moment.");
      }
      // Anthropic's own API contract guarantees this shape on a 2xx response
      // (checked structurally above); narrowing the validated object here.
      const anthropicBody = parsedBody as unknown as AnthropicResponse;
      return translateAnthropicResponseToChat(anthropicBody);
    } catch (err) {
      if (err instanceof UpstreamError) {
        const friendly = openAIUpstreamError(err);
        set.status = friendly.status;
        return friendly.body;
      }
      throw err;
    }
  },
  { body: ChatRequestSchema }
);
