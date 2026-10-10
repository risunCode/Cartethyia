import type { CanonicalEvent, CanonicalMessage, CanonicalRequest, ContentPart, ToolDefinition } from "../../../protocol/canonical-model";
import { canonicalTerminal } from "../../../protocol/codecs";
import { GatewayError } from "../../../protocol/gateway-error";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../contracts";
import { readCredentialSecret } from "../../contracts";
import { defineModel, type ModelDefinition } from "../../model-definition";
import { grokWebCookieHeader, parseGrokWebCredential, type GrokWebCredentials } from "./grok-web-auth";

const BASE_URL = "https://grok.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const INTENTS = {
  bash: "bash",
  shell: "bash",
  readfile: "readFile",
  read_file: "readFile",
  websearch: "webSearch",
  web_search: "webSearch",
  browsepage: "browsePage",
  browse_page: "browsePage",
} as const;

const MODEL_ROWS = [
  { id: "grok-3", ctx: 131072, out: 32768 },
  { id: "grok-4", ctx: 256000, out: 32768 },
] as const;

/** Static Grok web-session catalog. */
export const GROK_WEB_MODELS: readonly ModelDefinition[] = MODEL_ROWS.map((row) => ({
  ...defineModel({
    id: row.id,
    providerId: "grok-web",
    wireFamily: "chat",
    endpoint: "/rest/app-chat/conversations/new",
    ctx: row.ctx,
    out: row.out,
    vision: false,
    reasoning: true,
    toolCall: true,
  }),
  cost: { input: null, output: null, pricing_model: "subscription" as const },
}));

function textOf(part: ContentPart): string {
  if (part.kind === "text" || part.kind === "refusal") return part.text;
  if (part.kind === "image") return "[image omitted]";
  if (part.kind === "toolResult") {
    const content = typeof part.content === "string" ? part.content : part.content.map(textOf).filter(Boolean).join("\n");
    return `tool_result ${part.call_id}: ${content}`;
  }
  return "";
}

function renderPrompt(request: CanonicalRequest): string {
  const lines: string[] = [];
  for (const part of request.system ?? []) {
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

function toolOverrides(tools: readonly ToolDefinition[] | undefined): Array<{ intent: string; name: string }> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => {
    const intent = INTENTS[tool.name.replace(/[^A-Za-z0-9_]/g, "").toLowerCase() as keyof typeof INTENTS];
    if (intent === undefined) throw new GatewayError("invalid_request", 400, "Grok Web only supports bash, readFile, webSearch, and browsePage tools");
    return { intent, name: tool.name };
  });
}

/** Direct HTTP adapter for the Grok web session. */
export class GrokWebAdapter implements ProviderAdapter {
  readonly provider_id = "grok-web" as const;
  readonly #fetch: typeof fetch;

  constructor(fetchFn: typeof fetch = globalThis.fetch) {
    this.#fetch = fetchFn;
  }

  async *dispatch(request: CanonicalRequest, candidate: ProviderDispatchTarget, context: ProviderDispatchContext): AsyncIterable<CanonicalEvent> {
    const overrides = toolOverrides(request.tools);
    const creds = parseGrokWebCredential(readCredentialSecret(context.credential));
    const model = candidate.model_id || request.model;
    const created = await this.request(creds, "/rest/app-chat/conversations/new", { modelName: model, temporary: true }, context.abort_signal);
    const conversationId = record(created).conversationId;
    if (typeof conversationId !== "string" || !conversationId) throw new GatewayError("transport_unavailable", 502, "Grok Web did not return a conversation");
    const response = await this.request(creds, `/rest/app-chat/conversations/${conversationId}/responses`, {
      message: renderPrompt(request),
      modelName: model,
      ...(overrides === undefined ? {} : { toolOverrides: overrides }),
    }, context.abort_signal, "text/event-stream");
    if (!(response instanceof Response) || !response.body) throw new GatewayError("transport_unavailable", 502, "Grok Web response returned no response");
    yield* parseGrokSse(response.body, overrides ?? []);
  }

  private async request(creds: GrokWebCredentials, path: string, body: unknown, signal?: AbortSignal, accept = "application/json"): Promise<unknown> {
    const response = await this.#fetch(`${BASE_URL}${path}`, {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
      headers: {
        Cookie: grokWebCookieHeader(creds),
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
        "User-Agent": USER_AGENT,
        Accept: accept,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new GatewayError("transport_unavailable", response.status, `Grok Web response returned HTTP ${response.status}`);
    return accept === "text/event-stream" ? response : response.json();
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function* parseGrokSse(body: ReadableStream<Uint8Array>, overrides: readonly { intent: string; name: string }[]): AsyncIterable<CanonicalEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sequence = 1;
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
      if (typeof event.text === "string" && event.text.length > 0) {
        yield { type: "content_delta", sequence_number: sequence++, content: { kind: "text", text: event.text } };
      }
      const call = record(event.tool_call);
      const intent = typeof call.intent === "string" ? call.intent : "";
      const mapped = overrides.find((tool) => tool.intent === intent);
      if (mapped !== undefined) {
        yield {
          type: "tool_call_delta",
          sequence_number: sequence++,
          call_id: typeof call.id === "string" ? call.id : `call_${sequence}`,
          name: mapped.name,
          arguments_delta: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
        };
      }
    }
  }
  yield canonicalTerminal({ sequenceNumber: sequence, state: "complete", stopReason: "stop" });
}

/** Registry factory for the Grok web adapter. */
export function createGrokWebAdapter(fetchFn?: typeof fetch): GrokWebAdapter {
  return new GrokWebAdapter(fetchFn ?? globalThis.fetch);
}
