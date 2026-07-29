/**
 * POST /v1/responses/compact — OpenAI Responses compaction surface (REQ-22).
 *
 * Translates Responses → Chat, runs emulated compaction via shared core,
 * translates result back to Responses shape. No internal flags leak upstream.
 */

import { Elysia } from "elysia";
import { ResponsesRequestSchema } from "./schemas";
import { translateResponsesRequestToChat, translateChatResponseToResponses } from "../translate/openai-responses";
import type { OpenAIResponsesRequest } from "../translate/types";
import { openAIClientError } from "../http/errors";
import { runEmulatedCompact, CompactError } from "./compact-core";
import { createRequestTracker } from "../console/tracking/tracker";

export const responsesCompactRoute = new Elysia().post(
  "/v1/responses/compact",
  async ({ body, headers: rawHeaders, set, request }) => {
    const req = body as OpenAIResponsesRequest;
    const headers = rawHeaders as Record<string, string | undefined>;

    const tracker = createRequestTracker({
      endpoint: "/v1/responses/compact",
      surface: "responses",
      model: req.model,
      stream: false,
      request,
      apiKey: null,
      meta: { compact: true },
    });

    try {
      const chatReq = translateResponsesRequestToChat(req);

      const { response } = await runEmulatedCompact({
        model: req.model,
        chatReq,
        headers,
        request,
      });

      const result = translateChatResponseToResponses(response);
      return tracker.finishJson(200, result, undefined, req);
    } catch (err) {
      if (err instanceof CompactError) {
        set.status = err.status;
        tracker.fail(err.status, "compact_error", req);
        return openAIClientError(
          err.status,
          err.status === 401 || err.status === 403 ? "authentication_error" : "invalid_request_error",
          err.message,
        );
      }
      tracker.fail(500, "internal_error", req);
      throw err;
    }
  },
  { body: ResponsesRequestSchema },
);
