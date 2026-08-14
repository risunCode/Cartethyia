import { isRecord, normalizeFail, protocolError, type NormalizeInput, type NormalizeResult, type ProtocolError } from "../../application/protocols";
import { normalizeChatRequest, normalizeMessagesRequest, normalizeResponsesRequest, normalizeImageRequest } from "./request/index";
import type { Surface, ProxyEndpoint, RequestLimits } from "../../application/contracts";

/**
 * Pathname-to-proxy-endpoint lookup: the single source of truth for HTTP
 * routing. Returns the endpoint + client surface for proxy paths, null for
 * everything else (console, static, /v1/models, unknown).
 */
export function lookupProxyEndpoint(pathname: string): { readonly endpoint: ProxyEndpoint; readonly surface: Surface } | null {
  switch (pathname) {
    case "/v1/chat/completions":
      return { endpoint: "/v1/chat/completions", surface: "openai-chat" };
    case "/v1/messages":
      return { endpoint: "/v1/messages", surface: "anthropic-messages" };
    case "/v1/responses":
      return { endpoint: "/v1/responses", surface: "openai-responses" };
    case "/v1/images/generations":
      return { endpoint: "/v1/images/generations", surface: "images" };
    case "/v1/images/edits":
      return { endpoint: "/v1/images/edits", surface: "images" };
    default:
      return null;
  }
}

/** Authoritative endpoint-to-surface mapping for this proxy's surfaces. */
export function detectSurface(endpoint: ProxyEndpoint): Surface | null {
  switch (endpoint) {
    case "/v1/chat/completions":
      return "openai-chat";
    case "/v1/messages":
      return "anthropic-messages";
    case "/v1/responses":
      return "openai-responses";
    case "/v1/images/generations":
    case "/v1/images/edits":
      return "images";
    case "/v1/models":
      return null;
  }
}

/**
 * Endpoint-driven dispatch: validates and normalizes the wire body into the
 * application `NormalizedProviderRequest`, or returns a typed, sanitized failure.
 * Non-stream/stream semantics are carried by the narrowed `stream` boolean;
 * NDJSON-style multi-object bodies are rejected here (batch framing is a
 * transport concern, one request per HTTP call).
 */
export function normalizeRequest(endpoint: ProxyEndpoint, body: unknown, input: NormalizeInput): NormalizeResult {
  switch (endpoint) {
    case "/v1/chat/completions":
      return normalizeChatRequest(body, input);
    case "/v1/messages":
      return normalizeMessagesRequest(body, input);
    case "/v1/responses":
      return normalizeResponsesRequest(body, input);
    case "/v1/images/generations":
      return normalizeImageRequest(body, input, "generate");
    case "/v1/images/edits":
      return normalizeImageRequest(body, input, "edit");
    case "/v1/models":
      return normalizeFail(protocolError("endpoint", "model listing has no request body to normalize"));
  }
}

/**
 * Parses a raw request body under the pipeline byte bound (approximated by
 * UTF-16 length; transport slices may pre-validate exact bytes). Accepts
 * exactly one JSON object; NDJSON batch payloads (multiple JSON values) are
 * rejected with a typed error rather than silently using the first line.
 */
export function parseRequestBody(text: string, limits: RequestLimits): unknown | ProtocolError {
  if (text.length > limits.maxBodyBytes) return protocolError("body", `request body exceeds ${limits.maxBodyBytes} bytes`);
  const trimmed = text.trim();
  if (trimmed === "") return protocolError("body", "request body is empty");
  if (!trimmed.startsWith("{")) return protocolError("body", "request body must be a single JSON object (NDJSON batch bodies are not accepted)");
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return protocolError("body", "request body must be a JSON object");
    return parsed;
  } catch {
    return protocolError("body", "request body is not valid JSON");
  }
}
