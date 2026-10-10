import type { CanonicalEvent, CanonicalRequest, ContentPart } from "../../../protocol/canonical-model";
import { canonicalTerminal } from "../../../protocol/codecs";
import { GatewayError } from "../../../protocol/gateway-error";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../contracts";
import { readCredentialSecret } from "../../contracts";
import { defineModel, type ModelDefinition } from "../../model-definition";
import { parseKimiWebCredential } from "./kimi-web-auth";
import { consumeConnectFrames, FrameBuffer } from "../shared/connect";
import { webRecord, webTextOf } from "../shared/web-session";

const BASE_URL = "https://www.kimi.ai";
const CHAT_URL = `${BASE_URL}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const MODELS = [
  { id: "k3", ctx: 256000, out: 32000 },
  { id: "k2d6", ctx: 256000, out: 32000 },
] as const;

/** Static Kimi web catalog. Tool calling is intentionally absent. */
export const KIMI_WEB_MODELS: readonly ModelDefinition[] = MODELS.map((row) => defineModel({
  id: row.id, providerId: "kimi-web", wireFamily: "chat", endpoint: "/apiv2/kimi.gateway.chat.v1.ChatService/Chat", ctx: row.ctx, out: row.out,
  vision: false, reasoning: true, toolCall: false,
}));

/** Direct Connect-RPC adapter for the Kimi web session. */
export class KimiWebAdapter implements ProviderAdapter {
  readonly provider_id = "kimi-web" as const;
  readonly #fetch: typeof fetch;
  constructor(options: { readonly fetch?: typeof fetch } = {}) { this.#fetch = options.fetch ?? globalThis.fetch; }

  async *dispatch(request: CanonicalRequest, candidate: ProviderDispatchTarget, context: ProviderDispatchContext): AsyncIterable<CanonicalEvent> {
    if (request.tools && request.tools.length > 0) throw new GatewayError("invalid_request", 400, "Kimi Web does not support function tools");
    const model = candidate.model_id || request.model;
    if (!MODELS.some((row) => row.id === model)) throw new GatewayError("invalid_request", 400, `Unsupported Kimi Web model: ${model}`);
    const creds = parseKimiWebCredential(readCredentialSecret(context.credential));
    const folded = foldMessages(request);
    const response = await this.#fetch(CHAT_URL, {
      method: "POST",
      signal: context.abort_signal,
      headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/connect+json", Accept: "*/*", Origin: BASE_URL, Referer: `${BASE_URL}/`, "User-Agent": USER_AGENT, "connect-protocol-version": "1" },
      body: new Blob([frameConnect(JSON.stringify(chatBody(folded, model, webEffort(request.reasoning?.effort))))]),
    });
    if (!response.ok || !response.body) throw new GatewayError(response.status === 401 ? "authentication_failed" : "transport_unavailable", response.status || 502, `Kimi Web chat returned HTTP ${response.status || 502}`);
    yield* parseConnect(response.body, folded.prompt);
  }
}

function chatBody(folded: { prompt: string; systemPrompt: string }, model: string, effort: string | undefined): Record<string, unknown> {
  return {
    chat_id: "", scenario: "SCENARIO_K2D5", tools: [],
    message: { id: "", parent_id: "", children_message_ids: [], role: "user", blocks: [{ id: "", message_id: "", text: { content: folded.prompt } }], scenario: "SCENARIO_K2D5", labels: [], references: [], is_goal: false },
    options: { thinking: true, enable_plugin: false, ...(folded.systemPrompt ? { system_prompt: folded.systemPrompt } : {}), ...(effort ? { reasoning_effort: effort } : {}) },
    project_id: "", model,
  };
}

function frameConnect(json: string): ArrayBuffer {
  const payload = new TextEncoder().encode(json);
  const framed = new ArrayBuffer(5 + payload.length);
  const bytes = new Uint8Array(framed);
  new DataView(framed).setUint32(1, payload.length);
  bytes.set(payload, 5);
  return framed;
}

function foldMessages(request: CanonicalRequest): { prompt: string; systemPrompt: string } {
  const system = [...(request.system ?? []), ...(request.instructions ?? [])].map(textOf).filter(Boolean);
  const conversation: string[] = [];
  for (const message of request.messages) {
    const text = message.content.map(textOf).filter(Boolean).join("\n");
    if (!text) continue;
    if (message.role === "system") system.push(text);
    else conversation.push(conversation.length === 0 && message.role === "user" ? text : `${message.role === "assistant" ? "Assistant" : "User"}: ${text}`);
  }
  const prompt = conversation.join("\n\n").trim();
  if (!prompt) throw new GatewayError("invalid_request", 400, "Kimi Web requires a non-empty user message");
  return { prompt, systemPrompt: system.join("\n\n").trim() };
}

function textOf(part: ContentPart): string {
  return webTextOf(part, () => {
    throw new GatewayError("invalid_request", 400, "Kimi Web only supports text message content");
  });
}

function webEffort(effort: NonNullable<CanonicalRequest["reasoning"]>["effort"]): string | undefined {
  if (effort === "none" || effort === undefined) return "REASONING_EFFORT_NONE";
  if (effort === "minimal" || effort === "low") return "REASONING_EFFORT_LOW";
  return undefined;
}

async function* parseConnect(body: ReadableStream<Uint8Array>, prompt: string): AsyncIterable<CanonicalEvent> {
  const reader = body.getReader();
  const buffer = new FrameBuffer();
  let sequence = 1;
  let outputChars = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { frames } = consumeConnectFrames(buffer.view(), {
      maxPayloadBytes: 8 * 1024 * 1024,
      oversizeError: () => new GatewayError("platform_unavailable", 502, "Kimi Web frame is too large"),
    });
    if (frames.length > 0) {
      // Consumed bytes are counted, not offsets: `view()` is a subarray that
      // `append` may relocate, so an offset kept across reads would be stale.
      let consumed = 0;
      for (const frame of frames) {
        consumed += 5 + frame.payload.length;
        if (frame.payload.length === 0) continue;
        const message = JSON.parse(decoder.decode(frame.payload)) as Record<string, unknown>;
        if ((frame.flags & 0x02) !== 0 && webRecord(message.error).message) throw new GatewayError("transport_unavailable", 502, `Kimi Web stream failed: ${String(webRecord(message.error).message)}`);
        const delta = extractDelta(message);
        if (!delta) continue;
        outputChars += delta.text.length;
        yield { type: "content_delta", sequence_number: sequence++, content: delta.kind === "think" ? { kind: "reasoning", payload: null, summary: delta.text } : { kind: "text", text: delta.text } };
      }
      buffer.consume(consumed);
    }
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer.append(chunk.value);
  }
  const inputTokens = Math.max(1, Math.ceil(prompt.length / 4));
  const outputTokens = Math.max(1, Math.ceil(outputChars / 4));
  yield canonicalTerminal({ sequenceNumber: sequence, state: "complete", stopReason: "stop", usage: { input_tokens: inputTokens, cached_input_tokens: "unavailable", cache_write_tokens: "unavailable", uncached_input_tokens: "unavailable", output_tokens: outputTokens, reasoning_tokens: "unavailable", estimated_cost: null, total_tokens: inputTokens + outputTokens } });
}

function extractDelta(message: Record<string, unknown>): { kind: "text" | "think"; text: string } | undefined {
  const op = String(message.op ?? "");
  const mask = String(message.mask ?? "");
  const block = webRecord(message.block);
  const field = mask.startsWith("block.think") ? "think" : mask.startsWith("block.text") ? "text" : "";
  if (!field || (op !== "append" && op !== "set")) return undefined;
  const text = webRecord(block[field]).content;
  return typeof text === "string" && text ? { kind: field, text } : undefined;
}


/** Registry factory for the Kimi web adapter. */
export function createKimiWebAdapter(options: { readonly fetch?: typeof fetch } = {}): KimiWebAdapter {
  return new KimiWebAdapter(options);
}
