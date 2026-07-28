/**
 * Upstream provider access — fetch wrappers for OpenAI and Anthropic, plus
 * shared provider selection / credential resolution. Kept in one file since
 * the three pieces exist for a single reason: "talk to / choose between the
 * two upstreams", and the two fetch wrappers mirror each other closely
 * enough (`call`, `listModels`, BYOK header handling, no retry/backoff logic
 * — that belongs to a resilience layer outside Cartethyia's scope) that
 * splitting them only forces jumping between files to compare the two
 * providers.
 */

import { config } from "../config";
import { prepareOutboundRequest } from "./outbound";

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
  }
}

// ── Provider selection + credential resolution ───────────────────────────

/**
 * Provider routing: `claude-*` model names go to Anthropic, everything else
 * goes to OpenAI. This core build has no custom-provider registry: both
 * upstream endpoints are the official provider APIs and credentials always
 * come from the current caller (BYOK).
 */
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

export type Provider = "openai" | "anthropic";

export function selectProvider(model: string): Provider {
  return model.startsWith("claude") ? "anthropic" : "openai";
}

export interface InboundHeaders {
  authorization?: string;
  "x-api-key"?: string;
}

/** For the core build, forward the caller's OpenAI credential unchanged. */
export function resolveOpenAIAuth(headers: InboundHeaders): string | undefined {
  return headers.authorization;
}

/** For Anthropic, accept x-api-key or adapt an OpenAI-style bearer credential. */
export function resolveAnthropicAuth(headers: InboundHeaders): string | undefined {
  if (headers["x-api-key"]) return headers["x-api-key"];
  if (headers.authorization?.startsWith("Bearer ")) return headers.authorization.slice(7);
  return undefined;
}

// ── OpenAI ────────────────────────────────────────────────────────────

/** Caller-provided OpenAI credential passed through from the inbound request. */
export interface UpstreamCallOptions {
  authorizationHeader: string | undefined;
}

async function callOpenAI(path: string, body: unknown, opts: UpstreamCallOptions): Promise<Response> {
  const apiKey = opts.authorizationHeader;
  if (!apiKey) throw new UpstreamError("no OpenAI credential supplied", 401, "");
  const outboundBody = prepareOutboundRequest(body, "openai", config.transforms);

  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: apiKey },
    body: JSON.stringify(outboundBody),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new UpstreamError(`OpenAI upstream ${path} returned ${res.status}`, res.status, errBody);
  }
  return res;
}

export async function callChatCompletions(body: unknown, opts: UpstreamCallOptions): Promise<Response> {
  return callOpenAI("/chat/completions", body, opts);
}

export async function callResponses(body: unknown, opts: UpstreamCallOptions): Promise<Response> {
  return callOpenAI("/responses", body, opts);
}

export async function listOpenAIModels(opts: UpstreamCallOptions): Promise<Response> {
  const apiKey = opts.authorizationHeader;
  if (!apiKey) throw new UpstreamError("no OpenAI credential supplied", 401, "");

  const res = await fetch(`${OPENAI_BASE_URL}/models`, { headers: { authorization: apiKey } });
  if (!res.ok) throw new UpstreamError(`OpenAI upstream /models returned ${res.status}`, res.status, await res.text());
  return res;
}

// ── Anthropic ─────────────────────────────────────────────────────────

/** Caller-provided Anthropic credential passed through from the inbound request. */
export interface AnthropicUpstreamCallOptions {
  apiKeyHeader: string | undefined;
}

async function callAnthropic(path: string, body: unknown, opts: AnthropicUpstreamCallOptions): Promise<Response> {
  const apiKey = opts.apiKeyHeader;
  if (!apiKey) throw new UpstreamError("no Anthropic credential supplied", 401, "");
  const outboundBody = prepareOutboundRequest(body, "anthropic", config.transforms);

  const res = await fetch(`${ANTHROPIC_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(outboundBody),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new UpstreamError(`Anthropic upstream ${path} returned ${res.status}`, res.status, errBody);
  }
  return res;
}

export async function callMessages(body: unknown, opts: AnthropicUpstreamCallOptions): Promise<Response> {
  return callAnthropic("/messages", body, opts);
}

export async function listAnthropicModels(opts: AnthropicUpstreamCallOptions): Promise<Response> {
  const apiKey = opts.apiKeyHeader;
  if (!apiKey) throw new UpstreamError("no Anthropic credential supplied", 401, "");

  const res = await fetch(`${ANTHROPIC_BASE_URL}/models`, {
    headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
  });
  if (!res.ok) throw new UpstreamError(`Anthropic upstream /models returned ${res.status}`, res.status, await res.text());
  return res;
}
