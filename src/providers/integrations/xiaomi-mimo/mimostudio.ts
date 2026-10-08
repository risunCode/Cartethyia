import { randomUUID } from "node:crypto";
import type {
  CanonicalEvent,
  CanonicalRequest,
  ContentPart,
} from "../../../transport/canonical-model";
import { GatewayError } from "../../../transport/gateway-error";
import { defineModel } from "../../model-definition";
import type {
  ModelDefinition,
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../provider-registry";
import { usageFromProvider } from "../../usage";
import { MimoStudioSessionStore } from "./mimostudio-session";
import {
  extractMimoStudioToolCalls,
  renderMimoStudioToolInstruction,
  toMimoStudioToolHistory,
} from "./mimostudio-tools";
import { MimoThinkSplitter } from "./think-stream";
import {
  buildMimoStudioCookieHeader,
  MIMO_STUDIO_UA,
  parseMimoStudioCredential,
} from "./mimostudio-auth";

export const MIMOSTUDIO_PROVIDER_ID = "mimostudio" as const;
export const MIMOSTUDIO_BASE_URL = "https://aistudio.xiaomimimo.com" as const;
export const MIMOSTUDIO_CHAT_ENDPOINT = "/open-apis/bot/chat" as const;
/**
 * UltraSpeed is served on a separate chat prefix. The regular
 * `/open-apis/bot/chat` path rejects UltraSpeed model ids with
 * `模型名称错误`; the Studio UI's `#/ultra` surface calls
 * `/fastchat/open-apis/...` (captured from the live frontend).
 */
export const MIMOSTUDIO_FASTCHAT_ENDPOINT = "/fastchat/open-apis/bot/chat" as const;

export const MIMOSTUDIO_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "mimo-v2.6-pro": "mimo-v2.6-pro",
  "mimo-v2.6-flash": "mimo-v2.6-flash",
  // Studio's /open-apis/bot/config publishes UltraSpeed under this wire id.
  "mimo-v2.6-pro-ultraspeed": "mimo-v2.6-pro-ultraspeed-studio",
  "mimo-v2.6-pro-ultraspeed-studio": "mimo-v2.6-pro-ultraspeed-studio",
  "mimo-x-pro": "mimo-v2.6-pro",
  "mimo-x-flash": "mimo-v2.6-flash",
  "mimo-pro": "mimo-v2.6-pro",
  "mimo-flash": "mimo-v2.6-flash",
});

export function resolveMimoStudioModelId(requestedModel: string): string {
  const trimmed = requestedModel.trim();
  return MIMOSTUDIO_MODEL_ALIASES[trimmed] ?? trimmed;
}

function mimoStudioModel(
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  options: {
    readonly vision?: boolean;
    readonly reasoning?: boolean;
    readonly toolCall?: boolean;
    readonly endpoint?: string;
  } = {},
): ModelDefinition {
  return defineModel({
    id: modelId,
    providerId: MIMOSTUDIO_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: options.endpoint ?? MIMOSTUDIO_CHAT_ENDPOINT,
    ctx: contextLimit,
    out: outputLimit,
    vision: options.vision ?? true,
    reasoning: options.reasoning ?? true,
    toolCall: options.toolCall ?? true,
  });
}

export const MIMOSTUDIO_MODELS: readonly ModelDefinition[] = [
  mimoStudioModel("mimo-v2.6-flash", 1_048_576, 65_536, { reasoning: true, toolCall: true }),
  mimoStudioModel("mimo-v2.6-pro", 1_048_576, 65_536, { reasoning: true, toolCall: true }),
  mimoStudioModel("mimo-v2.6-pro-ultraspeed", 1_048_576, 65_536, {
    reasoning: true,
    toolCall: true,
    endpoint: MIMOSTUDIO_FASTCHAT_ENDPOINT,
  }),
  mimoStudioModel("mimo-v2.6-pro-ultraspeed-studio", 1_048_576, 65_536, {
    reasoning: true,
    toolCall: true,
    endpoint: MIMOSTUDIO_FASTCHAT_ENDPOINT,
  }),
  mimoStudioModel("mimo-x-flash", 1_048_576, 65_536, { reasoning: true, toolCall: true }),
  mimoStudioModel("mimo-x-pro", 1_048_576, 65_536, { reasoning: true, toolCall: true }),
];

function stringifyContentPart(part: ContentPart): string {
  if (part.kind === "text") return part.text;
  if (part.kind === "reasoning" && typeof part.payload === "string") return `[Thinking]\n${part.payload}`;
  return "";
}

/**
 * MiMo Studio reports an upstream rejection as an in-band `error` frame on an
 * HTTP 200 stream, not as an error status. Dropping that frame left the stream
 * ending with no terminal event, which the transport then reported as a 502
 * "upstream stream failed" — hiding the real reason from the operator and
 * mislabelling a caller-fixable request as a gateway fault.
 *
 * The frame's `content` is the upstream's own message, so the mapping is by
 * message text: this endpoint does not send a machine-readable error code.
 */
function mimoStudioErrorFrame(message: string): GatewayError {
  const normalized = message.toLowerCase();
  // The bot-chat endpoint refuses a `query` above ~50k characters with this
  // message; the prompt the caller sent is the thing that is too long.
  if (normalized.includes("too long")) {
    return new GatewayError(
      "context_length_exceeded",
      413,
      `MiMo Studio rejected the request: ${message}`,
      { providerId: MIMOSTUDIO_PROVIDER_ID },
      "upstream",
    );
  }
  // A second in-flight turn for the same chat is refused rather than queued.
  if (normalized.includes("do not submit repeatedly")) {
    return new GatewayError(
      "upstream_conflict",
      409,
      `MiMo Studio rejected the request: ${message}`,
      { providerId: MIMOSTUDIO_PROVIDER_ID },
      "upstream",
    );
  }
  return new GatewayError(
    "upstream_unprocessable",
    422,
    `MiMo Studio error: ${message}`,
    { providerId: MIMOSTUDIO_PROVIDER_ID },
    "upstream",
  );
}

/**
 * Measured upstream limit on the `query` field: above 50 000 characters the bot
 * endpoint answers HTTP 200 with an in-band `query is too long` error. The
 * model's own context window is far larger, so this is a property of this
 * endpoint's request envelope, not of the model. Keep a margin so a boundary
 * off-by-one cannot reintroduce the failure.
 */
const MAX_QUERY_CHARS = 48_000;

/**
 * Flattens the canonical conversation into the single `query` string the bot
 * endpoint accepts, and reports how many turns actually made it in.
 *
 * `skipTurns` drops leading non-system turns the upstream conversation already
 * holds, which is what keeps a long chat inside the endpoint's `query` limit:
 * the upstream keeps the history server-side, so only new turns need sending.
 * System instructions are always re-sent — they are not part of the upstream
 * conversation, and a resumed turn still needs the tool contract.
 *
 * Whatever remains is still capped: a first turn (or a chat that outgrew the
 * store) can carry more history than the endpoint accepts, and the oldest turns
 * are dropped rather than failing the request outright. The caller records only
 * the forwarded turns, so the upstream is never credited with context it did
 * not receive.
 */
function serializeCanonicalMessages(
  request: CanonicalRequest,
  skipTurns = 0,
): { query: string; forwardedStart: number; forwardedTurns: number } {
  const systemTexts: string[] = [];
  for (const m of request.messages) {
    if (m.role === "system") {
      const text = m.content.map(stringifyContentPart).join(" ").trim();
      if (text) systemTexts.push(text);
    }
  }
  // The bot endpoint ignores a `tools` field, so the tool contract travels in
  // the prompt; see `mimostudio-tools.ts` for why the model's own convention
  // is used rather than an invented one.
  const tools = request.tools ?? [];
  if (tools.length > 0 && request.tool_choice !== "none") {
    systemTexts.push(renderMimoStudioToolInstruction(tools));
  }
  const systemBlock = systemTexts.length > 0 ? `[系统指令]\n${systemTexts.join("\n")}` : "";

  const nonSystem = toMimoStudioToolHistory(request.messages)
    .filter((m) => m.role !== "system")
    .slice(skipTurns);
  const turns = nonSystem.map((m, i) => {
    const content = m.content.map(stringifyContentPart).join(" ").trim();
    if (i === nonSystem.length - 1 && m.role === "user") return `[当前问题]\n${content}`;
    return `${m.role}: ${content}`;
  });

  let dropped = 0;
  let body = turns.join("\n\n");
  let total = systemBlock.length + body.length + 2;
  // Drop from the oldest end so the newest question and its immediate context
  // survive; a turn is indivisible, so the cut lands on a turn boundary.
  while (total > MAX_QUERY_CHARS && turns.length - dropped > 1) {
    dropped += 1;
    body = turns.slice(dropped).join("\n\n");
    total = systemBlock.length + body.length + 2;
  }
  // One turn alone can still exceed the cap; it is what the caller asked, and
  // the upstream reports the real rejection rather than the gateway silently
  // truncating a question the model was supposed to answer.
  if (dropped > 0) {
    body = `[提示]\n较早的对话轮次因长度限制已省略。\n\n${body}`;
  }

  const query = systemBlock.length > 0 ? `${systemBlock}\n\n${body}` : body;
  return { query, forwardedStart: dropped, forwardedTurns: turns.length - dropped };
}

export class MimoStudioAdapter implements ProviderAdapter {
  readonly provider_id = MIMOSTUDIO_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly sessions = new MimoStudioSessionStore();

  constructor(options: { readonly fetch?: typeof fetch } = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    // The endpoint has no structured tool transport, so tool blocks in the
    // answer become canonical tool-call events here.
    return extractMimoStudioToolCalls(request, this.dispatchRaw(request, candidate, context));
  }

  private async *dispatchRaw(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    const rawSecret = context.credential.secret
      ? new TextDecoder().decode(context.credential.secret)
      : "";
    const creds = parseMimoStudioCredential(rawSecret);

    const targetModel = resolveMimoStudioModelId(candidate.model_id || request.model);
    const now = Date.now();
    const conversation = this.sessions.resolve(request, context, now);
    const { query, forwardedStart, forwardedTurns } = serializeCanonicalMessages(request, conversation.skipTurns);
    this.sessions.commit(request, conversation, forwardedStart, forwardedTurns, now);

    const body = {
      msgId: randomUUID().replace(/-/g, "").slice(0, 32),
      conversationId: conversation.conversationId,
      query,
      modelConfig: {
        model: targetModel,
        enableThinking: true,
        webSearchStatus: "disabled",
      },
      multiMedias: [],
    };

    const cookie = buildMimoStudioCookieHeader(creds);
    // UltraSpeed lives on `/fastchat/open-apis/bot/chat`; flash/pro stay on the
    // regular bot chat path. The routing target carries the model's endpoint.
    const endpointPath = candidate.endpoint_path?.startsWith("/")
      ? candidate.endpoint_path
      : MIMOSTUDIO_CHAT_ENDPOINT;
    const chatUrl = `${MIMOSTUDIO_BASE_URL}${endpointPath}`;
    const url = creds.phToken
      ? `${chatUrl}?xiaomichatbot_ph=${encodeURIComponent(creds.phToken)}`
      : chatUrl;

    const res = await this.fetchFn(url, {
      method: "POST",
      signal: context.abort_signal,
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: "https://aistudio.xiaomimimo.com",
        Referer: "https://aistudio.xiaomimimo.com/",
        "User-Agent": MIMO_STUDIO_UA,
        "x-timezone": "Asia/Shanghai",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new GatewayError(
        "transport_unavailable",
        res.status,
        `MiMo Studio returned HTTP ${res.status}: ${errText.slice(0, 200)}`,
      );
    }

    if (!res.body) {
      throw new GatewayError("transport_unavailable", 502, "MiMo Studio response body is missing");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const think = new MimoThinkSplitter();
    let buffer = "";
    let currentEvent = "";
    let seq = 0;
    let terminalEmitted = false;

    const emitSplit = function* (split: { text: string; reasoning: string }): Generator<CanonicalEvent> {
      if (split.reasoning) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "reasoning", payload: null, summary: split.reasoning },
        };
      }
      if (split.text) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "text", text: split.text },
        };
      }
    };

    yield { type: "response_start", sequence_number: seq++, model: targetModel };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            currentEvent = "";
            continue;
          }
          if (trimmed.startsWith("event:")) {
            currentEvent = trimmed.slice(6).trim();
          } else if (trimmed.startsWith("data:")) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === "[DONE]") {
              if (!terminalEmitted) {
                yield* emitSplit(think.flush());
                yield {
                  type: "terminal",
                  state: "complete",
                  stop_reason: "stop",
                  sequence_number: seq++,
                };
                terminalEmitted = true;
              }
              continue;
            }
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(dataStr) as Record<string, unknown>;
            } catch {
              // Ignore incomplete frame
              continue;
            }
            if (currentEvent === "error") {
              const message = String(data["content"] ?? "").trim();
              throw mimoStudioErrorFrame(message.length > 0 ? message : "unspecified upstream error");
            }
            if (currentEvent === "message" || (!currentEvent && typeof data["content"] === "string")) {
              const text = String(data["content"] ?? "");
              if (text) yield* emitSplit(think.push(text));
            } else if (currentEvent === "usage") {
              const promptTokens = Number(data["promptTokens"] ?? 0);
              const completionTokens = Number(data["completionTokens"] ?? 0);
              const nativeUsage = data["nativeUsage"] as Record<string, unknown> | undefined;
              const reasoningTokens = Number(
                (nativeUsage?.["completion_tokens_details"] as Record<string, unknown> | undefined)?.["reasoning_tokens"] ?? 0,
              );
              const usage = usageFromProvider({
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                reasoning_tokens: reasoningTokens > 0 ? reasoningTokens : undefined,
              });
              if (usage) {
                yield {
                  type: "usage",
                  sequence_number: seq++,
                  usage,
                };
              }
            } else if (currentEvent === "finish" && !terminalEmitted) {
              yield* emitSplit(think.flush());
              yield {
                type: "terminal",
                state: "complete",
                stop_reason: "stop",
                sequence_number: seq++,
              };
              terminalEmitted = true;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!terminalEmitted) {
      yield* emitSplit(think.flush());
      yield {
        type: "terminal",
        state: "failed",
        stop_reason: "error",
        sequence_number: seq++,
      };
    }
  }
}

export function createMimoStudioAdapter(options: { readonly fetch?: typeof fetch } = {}): ProviderAdapter {
  return new MimoStudioAdapter(options);
}
