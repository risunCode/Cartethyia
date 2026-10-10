import { randomUUID } from "node:crypto";
import type { CanonicalEvent, CanonicalRequest, ToolDefinition } from "../../../protocol/canonical-model";
import { canonicalTerminal } from "../../../protocol/codecs";
import { GatewayError } from "../../../protocol/gateway-error";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../contracts";
import { readCredentialSecret } from "../../contracts";
import { defineModel, type ModelDefinition } from "../../model-definition";
import { claudeWebCookieHeader, parseClaudeWebCredential, type ClaudeWebCredentials } from "./claude-web-auth";
import { webRecord, webRenderPrompt } from "../shared/web-session";

const BASE_URL = "https://claude.ai";
const ROOT_MESSAGE = "00000000-0000-4000-8000-000000000000";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const MODEL_ROWS = [
  { id: "claude-sonnet-4-5", ctx: 200000, out: 64000 },
  { id: "claude-opus-4-1", ctx: 200000, out: 32000 },
  { id: "claude-haiku-4-5", ctx: 200000, out: 64000 },
  { id: "claude-3-7-sonnet", ctx: 200000, out: 64000 },
] as const;

/** Static Claude web-session catalog. */
export const CLAUDE_WEB_MODELS: readonly ModelDefinition[] = MODEL_ROWS.map((row) => ({
  ...defineModel({
    id: row.id,
    providerId: "claude-web",
    wireFamily: "chat",
    endpoint: "/api/organizations",
    ctx: row.ctx,
    out: row.out,
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
  cost: { input: null, output: null, pricing_model: "subscription" as const },
}));

function renderPrompt(request: CanonicalRequest): string {
  return webRenderPrompt(request, (unsupported) => (unsupported.kind === "image" ? "[image omitted]" : ""));
}

function webTools(tools: readonly ToolDefinition[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    input_schema: tool.jsonSchema,
  }));
}

/** Confirms the stored session can read an organization. */
export async function validateClaudeWebSession(encoded: string, fetchFn: typeof fetch = globalThis.fetch): Promise<void> {
  await new ClaudeWebAdapter(fetchFn).organization(parseClaudeWebCredential(encoded));
}

/** Direct HTTP adapter for the Claude web session. */
export class ClaudeWebAdapter implements ProviderAdapter {
  readonly provider_id = "claude-web" as const;
  readonly #fetch: typeof fetch;
  readonly #organizations = new Map<string, string>();

  constructor(fetchFn: typeof fetch = globalThis.fetch) {
    this.#fetch = fetchFn;
  }

  async *dispatch(request: CanonicalRequest, candidate: ProviderDispatchTarget, context: ProviderDispatchContext): AsyncIterable<CanonicalEvent> {
    const creds = parseClaudeWebCredential(readCredentialSecret(context.credential));
    const org = await this.organization(creds, context.abort_signal);
    const created = await this.request(creds, "POST", `/api/organizations/${org}/chat_conversations`, { name: "Cartethyia", organization_uuid: org }, context.abort_signal);
    const conversation = webRecord(created).uuid;
    if (typeof conversation !== "string" || !conversation) throw new GatewayError("transport_unavailable", 502, "Claude Web did not return a conversation");
    try {
      const tools = webTools(request.tools);
      const response = await this.request(creds, "POST", `/api/organizations/${org}/chat_conversations/${conversation}/completion`, {
        prompt: renderPrompt(request),
        parent_message_uuid: ROOT_MESSAGE,
        timezone: "UTC",
        locale: "en-US",
        model: candidate.model_id || request.model,
        ...(tools === undefined ? {} : { tools }),
        turn_message_uuids: { human_message_uuid: randomUUID(), assistant_message_uuid: randomUUID() },
        attachments: [],
        files: [],
        sync_sources: [],
        rendering_mode: "messages",
      }, context.abort_signal, "text/event-stream");
      if (!(response instanceof Response) || !response.body) throw new GatewayError("transport_unavailable", 502, "Claude Web completion returned no response");
      yield* parseClaudeSse(response.body);
    } finally {
      await this.request(creds, "DELETE", `/api/organizations/${org}/chat_conversations/${conversation}`, undefined, context.abort_signal).catch(() => undefined);
    }
  }

  async organization(creds: ClaudeWebCredentials, signal?: AbortSignal): Promise<string> {
    const cached = this.#organizations.get(creds.cookie);
    if (cached) return cached;
    const payload = await this.request(creds, "GET", "/api/organizations", undefined, signal);
    const rows = Array.isArray(payload) ? payload : webRecord(payload).organizations;
    const first = Array.isArray(rows) ? webRecord(rows[0]).uuid : undefined;
    if (typeof first !== "string" || !first) throw new GatewayError("authentication_failed", 401, "Claude Web session has no organization");
    this.#organizations.set(creds.cookie, first);
    return first;
  }

  private async request(creds: ClaudeWebCredentials, method: string, path: string, body: unknown, signal?: AbortSignal, accept = "application/json"): Promise<unknown> {
    const response = await this.#fetch(`${BASE_URL}${path}`, {
      method,
      ...(signal === undefined ? {} : { signal }),
      headers: {
        Cookie: claudeWebCookieHeader(creds),
        Origin: BASE_URL,
        Referer: `${BASE_URL}/new`,
        "User-Agent": USER_AGENT,
        Accept: accept,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new GatewayError("authentication_failed", 401, "Claude Web session is not signed in");
      const label = path.endsWith("/completion") ? "completion" : path.endsWith("/organizations") ? "organizations" : "conversation";
      throw new GatewayError("transport_unavailable", response.status, `Claude Web ${label} returned HTTP ${response.status}`);
    }
    if (accept === "text/event-stream") return response;
    if (method === "DELETE") return undefined;
    return response.json();
  }
}

async function* parseClaudeSse(body: ReadableStream<Uint8Array>): AsyncIterable<CanonicalEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sequence = 1;
  let callId = "";
  let callName = "";
  let callArgs = "";
  const flushCall = (): CanonicalEvent | undefined => {
    if (!callId) return undefined;
    const event: CanonicalEvent = { type: "tool_call_delta", sequence_number: sequence++, call_id: callId, name: callName, arguments_delta: callArgs };
    callId = "";
    callName = "";
    callArgs = "";
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
      const delta = webRecord(event.delta);
      const block = webRecord(event.content_block);
      if (event.type === "content_block_delta" && delta.type === "text_delta" && typeof delta.text === "string") {
        yield { type: "content_delta", sequence_number: sequence++, content: { kind: "text", text: delta.text } };
      } else if (event.type === "content_block_start" && block.type === "tool_use") {
        const pending = flushCall();
        if (pending) yield pending;
        callId = typeof block.id === "string" ? block.id : "";
        callName = typeof block.name === "string" ? block.name : "";
      } else if (event.type === "content_block_delta" && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        callArgs += delta.partial_json;
      } else if (event.type === "content_block_stop") {
        const pending = flushCall();
        if (pending) yield pending;
      }
    }
  }
  const pending = flushCall();
  if (pending) yield pending;
  yield canonicalTerminal({ sequenceNumber: sequence, state: "complete", stopReason: "stop" });
}

/** Registry factory for the Claude web adapter. */
export function createClaudeWebAdapter(fetchFn?: typeof fetch): ClaudeWebAdapter {
  return new ClaudeWebAdapter(fetchFn ?? globalThis.fetch);
}
