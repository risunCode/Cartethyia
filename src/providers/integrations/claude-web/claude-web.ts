import { randomUUID } from "node:crypto";
import type { CanonicalEvent, CanonicalMessage, CanonicalRequest, ContentPart, ToolDefinition } from "../../../protocol/canonical-model";
import { canonicalTerminal } from "../../../protocol/codecs";
import { GatewayError } from "../../../protocol/gateway-error";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../contracts";
import { readCredentialSecret } from "../../contracts";
import { defineModel, type ModelDefinition } from "../../model-definition";
import { claudeWebCookieHeader, parseClaudeWebCredential, type ClaudeWebCredentials } from "./claude-web-auth";
import { createChromeFetch } from "./chrome-fetch";

const HOST = ["claude", "ai"].join(".");
const BASE_URL = `https://${HOST}`;
const ROOT_MESSAGE = "00000000-0000-4000-8000-000000000000";
const COMPLETION_PATH = "/api/organizations/{organization_uuid}/chat_conversations/{conversation_uuid}/completion";

const MODEL_PREFIX = ["cla", "ude"].join("");
const MODEL_ROWS = [
  { name: "opus-5-5", ctx: 1000000, out: 128000 },
  { name: "sonnet-5-5", ctx: 1000000, out: 128000 },
  { name: "haiku-5-5", ctx: 1000000, out: 128000 },
  { name: "sonnet-4-6", ctx: 200000, out: 64000 },
].map((row) => ({ id: `${MODEL_PREFIX}-${row.name}`, ctx: row.ctx, out: row.out }));

/** Static Claude web-session catalog. */
export const CLAUDE_WEB_MODELS: readonly ModelDefinition[] = MODEL_ROWS.map((row) => defineModel({
  id: row.id, providerId: "claude-web", wireFamily: "chat", endpoint: COMPLETION_PATH, ctx: row.ctx, out: row.out,
  vision: true, reasoning: true, toolCall: true,
}));

function textOf(part: ContentPart): string {
  if (part.kind === "text" || part.kind === "refusal") return part.text;
  if (part.kind === "image") return "[image omitted]";
  if (part.kind === "toolResult") {
    const content = typeof part.content === "string" ? part.content : part.content.map(textOf).filter(Boolean).join("\n");
    return `tool_result ${part.call_id}: ${content}`;
  }
  if (part.kind === "toolCall") return `tool_call ${part.name}: ${JSON.stringify(part.arguments)}`;
  return "";
}

function renderPrompt(request: CanonicalRequest): string {
  const lines: string[] = [];
  for (const part of [...(request.system ?? []), ...(request.instructions ?? [])]) {
    const text = textOf(part);
    if (text) lines.push(`system: ${text}`);
  }
  for (const message of request.messages) lines.push(...renderMessage(message));
  return lines.join("\n");
}

function renderMessage(message: CanonicalMessage): string[] {
  if (message.role === "system") return message.content.map(textOf).filter(Boolean).map((text) => `system: ${text}`);
  return message.content.map(textOf).filter(Boolean).map((text) => `${message.role}: ${text}`);
}

function webTools(tools: readonly ToolDefinition[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), input_schema: tool.jsonSchema }));
}

/** Confirms the stored session can read an organization. */
export async function validateClaudeWebSession(encoded: string, fetchFn: typeof fetch = globalThis.fetch): Promise<void> {
  await new ClaudeWebAdapter({ fetch: fetchFn }).organization(parseClaudeWebCredential(encoded));
}

/** Direct HTTP adapter for the Claude web session. */
export class ClaudeWebAdapter implements ProviderAdapter {
  readonly provider_id = "claude-web" as const;
  readonly #fetch: typeof fetch;
  readonly #organizations = new Map<string, string>();
  constructor(options: { readonly fetch?: typeof fetch } = {}) { this.#fetch = options.fetch ?? createChromeFetch(); }

  async *dispatch(request: CanonicalRequest, candidate: ProviderDispatchTarget, context: ProviderDispatchContext): AsyncIterable<CanonicalEvent> {
    const creds = parseClaudeWebCredential(readCredentialSecret(context.credential));
    const org = await this.organization(creds, context.abort_signal);
    const created = await this.request(creds, "POST", `/api/organizations/${org}/chat_conversations`, { name: "", organization_uuid: org }, context.abort_signal);
    const conversation = record(created).uuid;
    if (typeof conversation !== "string" || !conversation) throw new GatewayError("transport_unavailable", 502, "Claude Web did not return a conversation");
    try {
      const tools = webTools(request.tools);
      const effort = webEffort(request.reasoning?.effort);
      const body = {
        prompt: renderPrompt(request), parent_message_uuid: ROOT_MESSAGE, timezone: "UTC", locale: "en-US",
        model: candidate.model_id || request.model, ...(tools === undefined ? {} : { tools }),
        ...(effort === undefined ? {} : { effort, thinking_mode: "extended" }),
        turn_message_uuids: { human_message_uuid: randomUUID(), assistant_message_uuid: randomUUID() },
        attachments: [], files: [], sync_sources: [], rendering_mode: "messages",
      };
      const response = await this.request(creds, "POST", `/api/organizations/${org}/chat_conversations/${conversation}/completion`, body, context.abort_signal, "text/event-stream");
      if (!(response instanceof Response) || !response.body) throw new GatewayError("transport_unavailable", 502, "Claude Web completion returned no response");
      yield* parseClaudeSse(response.body, renderPrompt(request));
    } finally {
      await this.request(creds, "DELETE", `/api/organizations/${org}/chat_conversations/${conversation}`, undefined, context.abort_signal).catch(() => undefined);
    }
  }

  async organization(creds: ClaudeWebCredentials, signal?: AbortSignal): Promise<string> {
    const cached = this.#organizations.get(creds.cookie);
    if (cached) return cached;
    const payload = await this.request(creds, "GET", "/api/organizations", undefined, signal);
    const rows = Array.isArray(payload) ? payload : record(payload).organizations;
    const first = Array.isArray(rows) ? record(rows[0]).uuid : undefined;
    if (typeof first !== "string" || !first) throw new GatewayError("authentication_failed", 401, "Claude Web session has no organization");
    this.#organizations.set(creds.cookie, first);
    return first;
  }

  private async request(creds: ClaudeWebCredentials, method: string, path: string, body: unknown, signal?: AbortSignal, accept = "application/json"): Promise<unknown> {
    const response = await this.#fetch(`${BASE_URL}${path}`, {
      method, ...(signal === undefined ? {} : { signal }),
      headers: { Cookie: claudeWebCookieHeader(creds), Origin: BASE_URL, Referer: `${BASE_URL}/`, Accept: accept, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const label = path.endsWith("/completion") ? "completion" : path.endsWith("/organizations") ? "organizations" : "conversation";
      throw new GatewayError(label === "organizations" && response.status === 401 ? "authentication_failed" : "transport_unavailable", response.status, `Claude Web ${label} returned HTTP ${response.status}`);
    }
    if (accept === "text/event-stream") return response;
    if (method === "DELETE") return undefined;
    return response.json();
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function* parseClaudeSse(body: ReadableStream<Uint8Array>, prompt: string): AsyncIterable<CanonicalEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sequence = 1;
  let outputChars = 0;
  let callId = "";
  let callName = "";
  let callArgs = "";
  const flushCall = (): CanonicalEvent | undefined => {
    if (!callId) return undefined;
    const event: CanonicalEvent = { type: "tool_call_delta", sequence_number: sequence++, call_id: callId, name: callName, arguments_delta: callArgs };
    callId = ""; callName = ""; callArgs = "";
    return event;
  };
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as Record<string, unknown>;
      const delta = record(event.delta);
      const block = record(event.content_block);
      if (event.type === "content_block_start" && block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
        outputChars += block.thinking.length;
        yield { type: "content_delta", sequence_number: sequence++, content: { kind: "reasoning", payload: null, summary: block.thinking } };
      } else if (event.type === "content_block_delta" && delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        outputChars += delta.thinking.length;
        yield { type: "content_delta", sequence_number: sequence++, content: { kind: "reasoning", payload: null, summary: delta.thinking } };
      } else if (event.type === "content_block_delta" && delta.type === "thinking_summary_delta") {
        const summary = typeof delta.summary === "string" ? delta.summary : record(delta.summary).summary;
        if (typeof summary === "string" && summary.length > 0) {
          outputChars += summary.length;
          yield { type: "content_delta", sequence_number: sequence++, content: { kind: "reasoning", payload: null, summary } };
        }
      } else if (event.type === "content_block_delta" && delta.type === "text_delta" && typeof delta.text === "string") {
        outputChars += delta.text.length;
        yield { type: "content_delta", sequence_number: sequence++, content: { kind: "text", text: delta.text } };
      } else if (event.type === "content_block_start" && block.type === "tool_use") {
        const pending = flushCall();
        if (pending) yield pending;
        callId = typeof block.id === "string" ? block.id : "";
        callName = typeof block.name === "string" ? block.name : "";
      } else if (event.type === "content_block_delta" && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        callArgs += delta.partial_json;
        outputChars += delta.partial_json.length;
      } else if (event.type === "content_block_stop") {
        const pending = flushCall();
        if (pending) yield pending;
      }
    }
  }
  const pending = flushCall();
  if (pending) yield pending;
  const inputTokens = approximateTokens(prompt);
  const outputTokens = approximateTokens("", outputChars);
  yield canonicalTerminal({ sequenceNumber: sequence, state: "complete", stopReason: "stop", usage: { input_tokens: inputTokens, cached_input_tokens: "unavailable", cache_write_tokens: "unavailable", uncached_input_tokens: "unavailable", output_tokens: outputTokens, reasoning_tokens: "unavailable", estimated_cost: null, total_tokens: inputTokens + outputTokens } });
}

function webEffort(effort: NonNullable<CanonicalRequest["reasoning"]>["effort"]): "low" | "medium" | "high" | undefined {
  if (effort === "minimal" || effort === "low") return "low";
  if (effort === "medium") return "medium";
  if (effort === "high" || effort === "xhigh" || effort === "max") return "high";
  return undefined;
}

function approximateTokens(text: string, chars = text.length): number {
  return Math.max(1, Math.ceil(chars / 4));
}

/** Registry factory for the Claude web adapter. */
export function createClaudeWebAdapter(options: { readonly fetch?: typeof fetch } = {}): ClaudeWebAdapter {
  return new ClaudeWebAdapter(options);
}
