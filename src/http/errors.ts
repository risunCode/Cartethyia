/**
 * Friendly, provider-neutral client error envelopes. Errors should explain
 * what happened and what to try next without exposing upstream response
 * bodies, credentials, or implementation details.
 */

import { UpstreamError } from "../upstream/providers";

export interface OpenAIErrorResponse {
  error: {
    message: string;
    type: "authentication_error" | "invalid_request_error" | "rate_limit_error" | "upstream_error" | "internal_error";
  };
}

export interface AnthropicErrorResponse {
  type: "error";
  error: {
    type: "authentication_error" | "invalid_request_error" | "rate_limit_error" | "api_error";
    message: string;
  };
}

export type ClientErrorKind = "authentication_error" | "invalid_request_error" | "rate_limit_error" | "upstream_error" | "internal_error";

interface FriendlyError {
  status: number;
  kind: ClientErrorKind;
  message: string;
}

function friendlyUpstreamError(error: UpstreamError): FriendlyError {
  if (error.status === 401 || error.status === 403) {
    return {
      status: error.status,
      kind: "authentication_error",
      message: "I couldn’t authenticate this request with the selected provider. Please check that you sent a valid provider API key in Authorization: Bearer … or x-api-key, then try again.",
    };
  }
  if (error.status === 429) {
    return {
      status: 429,
      kind: "rate_limit_error",
      message: "The selected provider is rate-limiting this request right now. Please wait a moment, reduce concurrency, or retry with a smaller request.",
    };
  }
  if (error.status >= 400 && error.status < 500) {
    return {
      status: error.status,
      kind: "invalid_request_error",
      message: "The selected provider could not accept this request as sent. Please double-check the model, request fields, tool inputs, and account access before trying again.",
    };
  }
  return {
    status: error.status || 502,
    kind: "upstream_error",
    message: "The selected provider is having trouble completing this request right now. Your request was not changed; please retry shortly.",
  };
}

function openAIEnvelope(error: FriendlyError): OpenAIErrorResponse {
  return { error: { message: error.message, type: error.kind } };
}

function anthropicEnvelope(error: FriendlyError): AnthropicErrorResponse {
  const type = error.kind === "upstream_error" || error.kind === "internal_error" ? "api_error" : error.kind;
  return { type: "error", error: { type, message: error.message } };
}

/** Converts an expected provider failure into an OpenAI-compatible error envelope. */
export function openAIUpstreamError(error: UpstreamError): { status: number; body: OpenAIErrorResponse } {
  const friendly = friendlyUpstreamError(error);
  return { status: friendly.status, body: openAIEnvelope(friendly) };
}

/** Converts an expected provider failure into an Anthropic Messages error envelope. */
export function anthropicUpstreamError(error: UpstreamError): { status: number; body: AnthropicErrorResponse } {
  const friendly = friendlyUpstreamError(error);
  return { status: friendly.status, body: anthropicEnvelope(friendly) };
}

/** Returns a friendly OpenAI-compatible error for malformed or unexpected failures. */
export function openAIClientError(status: number, kind: Exclude<ClientErrorKind, "upstream_error">, message: string): OpenAIErrorResponse {
  return openAIEnvelope({ status, kind, message });
}

/** Returns a friendly Anthropic-compatible error for malformed or unexpected failures. */
export function anthropicClientError(status: number, kind: Exclude<ClientErrorKind, "upstream_error">, message: string): AnthropicErrorResponse {
  return anthropicEnvelope({ status, kind, message });
}

/** Returns a friendly rate-limit response when one IP has too many active requests. */
export function flightLimitError(pathname: string, active: number, limit: number): OpenAIErrorResponse | AnthropicErrorResponse {
  const message = `This IP already has ${active} active requests, which is the current limit of ${limit}. Please wait for an in-flight request to finish, reduce parallel work, then try again.`;
  if (pathname === "/v1/messages") return anthropicClientError(429, "rate_limit_error", message);
  return openAIClientError(429, "rate_limit_error", message);
}

/** A friendly default for unexpected route exceptions. */
export function unexpectedClientError(pathname: string): OpenAIErrorResponse | AnthropicErrorResponse {
  const message = "Something unexpected interrupted this request before it could finish. Please retry; if it keeps happening, simplify the request and check the server logs for the underlying detail.";
  if (pathname === "/v1/messages") return anthropicClientError(500, "internal_error", message);
  return openAIClientError(500, "internal_error", message);
}

/** A friendly response for routes this server does not serve. */
export function unknownRouteError(pathname: string): OpenAIErrorResponse | AnthropicErrorResponse {
  const message = "This server has no route at that path. Please check the URL against the supported endpoints and try again.";
  if (pathname === "/v1/messages") return anthropicClientError(404, "invalid_request_error", message);
  return openAIClientError(404, "invalid_request_error", message);
}

/** A friendly default for request-schema failures without echoing framework internals. */
export function invalidRequestError(pathname: string): OpenAIErrorResponse | AnthropicErrorResponse {
  const message = "I couldn’t read this request in the expected API format. Please check the required fields and their types, then try again.";
  if (pathname === "/v1/messages") return anthropicClientError(422, "invalid_request_error", message);
  return openAIClientError(422, "invalid_request_error", message);
}
