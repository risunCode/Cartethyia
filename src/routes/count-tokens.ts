/**
 * POST /v1/messages/count_tokens — Anthropic's token-counting endpoint.
 * Native Anthropic wire shape end to end (no Chat translation): the client
 * sends `model`/`messages`/`system?`/`tools?`/`tool_choice?` and gets back
 * `{ input_tokens }` without a completion ever being generated.
 *
 * Only providers whose upstream actually exposes this operation implement
 * it (`Provider.countTokens`) - the built-in "anthropic" provider and
 * "anthropic-compatible" custom providers. Every other provider (OpenAI,
 * Kimchi, Cursor, ...) has no equivalent endpoint to forward to, so a model
 * resolving to one of those fails with a clean 400 instead of a dispatch
 * that could never succeed.
 *
 * Two different failure categories, two different error paths (matching
 * routes/messages.ts's split between its own dispatchStandard client-error
 * branch and withProxyRequest's catch block): a routing-level rejection
 * (model unresolvable, provider has no countTokens, no credential) is this
 * route's OWN specific, already-safe message, returned directly via
 * `anthropicClientError`. A genuine upstream call failure (the actual HTTP
 * request to the provider's count_tokens endpoint) is a ProviderCallError
 * that propagates to withProxyRequest's catch block, which sanitizes it
 * through `anthropicUpstreamError` - upstream response text can carry
 * sensitive detail a routing check's own message never does.
 */

import { Elysia } from "elysia";
import { CountTokensRequestSchema } from "./schemas";
import { anthropicClientError, anthropicUpstreamError } from "../http/errors";
import { resolveQualifiedTarget } from "../routing/resolve";
import { resolveCredentialForDispatch, pickProxyTarget } from "../upstream/dispatch";
import { providerRegistry } from "../upstream/providers";
import { withProxyRequest } from "./middleware/proxyRequest";

interface CountTokensRequest {
  model: string;
  messages: unknown[];
  system?: unknown;
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export const countTokensRoute = new Elysia().post(
  "/v1/messages/count_tokens",
  async ({ body, headers, set, request, server }) => {
    const req = body as CountTokensRequest;

    return withProxyRequest(
      { endpoint: "/v1/messages/count_tokens", surface: "anthropic", model: req.model, stream: false, request, server, set, errorMapper: anthropicUpstreamError },
      async ({ tracker, recordRequestBody }) => {
        recordRequestBody(req);

        const resolved = await resolveQualifiedTarget(req.model);
        if ("error" in resolved) {
          const status = resolved.status ?? 400;
          set.status = status;
          tracker.fail(status, "invalid_request_error", req);
          return anthropicClientError(status, "invalid_request_error", resolved.error);
        }
        const target = resolved.target;

        const provider = providerRegistry.get(target.provider);
        if (!provider || !provider.countTokens) {
          set.status = 400;
          tracker.fail(400, "invalid_request_error", req);
          return anthropicClientError(
            400,
            "invalid_request_error",
            `count_tokens is not supported for provider "${target.provider}" — only Anthropic and Anthropic-compatible custom providers implement it.`
          );
        }

        const credential = await resolveCredentialForDispatch(target.provider, headers, target.modelId);
        if (!credential) {
          set.status = 401;
          tracker.fail(401, "authentication_error", req);
          return anthropicClientError(401, "authentication_error", "No credential available for this model.");
        }

        const { model: _model, ...rest } = req;
        const proxy = pickProxyTarget(target.provider);
        const { inputTokens } = await provider.countTokens(target, rest, credential, request.signal, proxy);
        return tracker.finishJson(200, { input_tokens: inputTokens }, target.provider, req);
      }
    );
  },
  { body: CountTokensRequestSchema }
);
