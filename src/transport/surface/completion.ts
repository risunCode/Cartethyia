import { GatewayError } from "../gateway-error";
import type { CanonicalEvent, CanonicalRequest, GenerationControls } from "../canonical-model";
import type { ReasoningIntent } from "../canonical-model";
import type { SurfaceAdapter, SurfaceInput, SurfaceOutput } from "./adapters";
import { eventText } from "./adapters";
import { isRecord } from "../../protocol/primitives";
import { textPart } from "./content-parts";
import { usageToChatWire, type OpenAiUsage } from "../../providers/usage";
import { TEXT_ENCODER } from "./stream-frame";
import { SurfaceStreamEncoder } from "./stream-base";

export interface CompletionEncodingOptions {
  response_id?: string;
  model?: string;
  created?: number;
  prompt?: unknown;
  echo?: boolean;
  suffix?: unknown;
}

interface CompletionChoice {
  text: string;
  index: number;
  logprobs: null;
  finish_reason: string | null;
}

function bodyOf(input: SurfaceInput | unknown): unknown {
  return isRecord(input) && "body" in input && "path" in input ? input.body : input;
}

function textPrompts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((prompt) => (typeof prompt === "string" ? [prompt] : []));
}

function stopReason(events: readonly CanonicalEvent[]): string | null {
  const terminal = [...events].reverse().find((event) => event.type === "terminal");
  if (terminal?.type !== "terminal") return null;
  if (terminal.stop_reason === "length") return "length";
  if (terminal.stop_reason === "content_filter") return "content_filter";
  if (terminal.state === "complete" || terminal.stop_reason === "stop") return "stop";
  return null;
}

/**
 * Completion wire usage. Delegates to the chat builder (same wire family) —
 * completion responses now carry cache/reasoning details instead of dropping
 * them (intended fix; previously only the three totals were forwarded).
 */
function usage(events: readonly CanonicalEvent[]): OpenAiUsage | undefined {
  const terminal = [...events].reverse().find((event) => event.type === "terminal");
  const record = terminal?.type === "terminal" ? terminal.usage : undefined;
  const event = [...events].reverse().find((item) => item.type === "usage");
  const source = record ?? (event?.type === "usage" ? event.usage : undefined);
  if (!source) return undefined;
  return usageToChatWire(source);
}

function outputText(events: readonly CanonicalEvent[], options: CompletionEncodingOptions): string {
  let text = events.flatMap((event) => (eventText(event) ?? "")).join("");
  if (options.echo === true) {
    const prompt = typeof options.prompt === "string" ? options.prompt : "";
    text = prompt + text;
  }
  if (typeof options.suffix === "string") text += options.suffix;
  return text;
}

function modelFor(events: readonly CanonicalEvent[], options: CompletionEncodingOptions): string {
  if (options.model !== undefined) return options.model;
  const start = events.find((event) => event.type === "message_start" || event.type === "response_start");
  return start?.type === "message_start" || start?.type === "response_start" ? start.model ?? "" : "";
}

export class CompletionStreamEncoder extends SurfaceStreamEncoder<CanonicalEvent, Record<string, unknown>> {
  /**
   * The last terminal and usage events seen, plus a count of text deltas.
   *
   * These three facts are all the encoder needs from the stream it has already
   * passed through. Keeping the events themselves made every text delta rescan
   * the whole array (O(n²) over a long completion) and retained the entire
   * response in memory.
   */
  private terminalEvent: CanonicalEvent | undefined;
  private usageEvent: CanonicalEvent | undefined;
  private textDeltaCount = 0;
  /**
   * One id for the whole stream. Generating it per chunk made every frame
   * carry a different `id`, which breaks clients that key a stream on the
   * completion id (and violates the wire contract: `id` identifies the
   * response, not the chunk).
   */
  private readonly id: string;
  private readonly created: number;

  constructor(private readonly options: CompletionEncodingOptions = {}) {
    super();
    this.id = options.response_id ?? `cmpl-${crypto.randomUUID()}`;
    this.created = options.created ?? Math.floor(Date.now() / 1000);
  }

  push(event: CanonicalEvent): Record<string, unknown>[] {
    if (event.type === "terminal") this.terminalEvent = event;
    if (event.type === "usage") this.usageEvent = event;
    const text = eventText(event);
    if (text === undefined) {
      if (event.type !== "terminal") return [];
      return [this.chunk("", this.stopReason(), this.usage())];
    }
    this.textDeltaCount += 1;
    return [this.chunk(this.options.echo === true && this.textDeltaCount === 1
      ? `${typeof this.options.prompt === "string" ? this.options.prompt : ""}${text}`
      : text, null)];
  }

  /** The wire stop reason from the terminal event seen so far. */
  private stopReason(): string | null {
    const terminal = this.terminalEvent;
    if (terminal?.type !== "terminal") return null;
    if (terminal.stop_reason === "length") return "length";
    if (terminal.stop_reason === "content_filter") return "content_filter";
    if (terminal.state === "complete" || terminal.stop_reason === "stop") return "stop";
    return null;
  }

  /** The wire usage from the terminal event, else the last usage event. */
  private usage(): OpenAiUsage | undefined {
    const terminal = this.terminalEvent;
    const record = terminal?.type === "terminal" ? terminal.usage : undefined;
    const event = this.usageEvent;
    const source = record ?? (event?.type === "usage" ? event.usage : undefined);
    if (!source) return undefined;
    return usageToChatWire(source);
  }

  finish(): Record<string, unknown>[] {
    return [];
  }

  private chunk(text: string, finish_reason: string | null, responseUsage?: OpenAiUsage): Record<string, unknown> {
    return {
      id: this.id,
      object: "text_completion",
      created: this.created,
      model: this.options.model ?? "",
      choices: [{ text, index: 0, logprobs: null, finish_reason } satisfies CompletionChoice],
      ...(responseUsage === undefined ? {} : { usage: responseUsage }),
    };
  }
}

export class CompletionAdapter implements SurfaceAdapter {
  readonly surface = "completion" as const;

  matchesBodyShape(body: unknown): boolean {
    if (!isRecord(body) || !("prompt" in body)) return false;
    return typeof body.prompt === "string" || Array.isArray(body.prompt);
  }

  parse(input: SurfaceInput | unknown): CanonicalRequest {
    const body = bodyOf(input);
    const value = isRecord(body) ? body : {};
    const prompts = textPrompts(value.prompt);
    if (prompts.length === 0)
      throw new GatewayError(
        "invalid_request",
        400,
        "completion requests require a non-empty prompt",
      );
    const controls: GenerationControls = {};
    for (const field of ["temperature", "top_p", "n", "seed"] as const)
      if (typeof value[field] === "number" && Number.isFinite(value[field])) controls[field] = value[field];
    if (typeof value.max_tokens === "number" && Number.isFinite(value.max_tokens))
      controls.max_tokens = value.max_tokens;
    if (typeof value.logprobs === "number" && Number.isFinite(value.logprobs)) {
      controls.logprobs = true;
      controls.top_logprobs = value.logprobs;
    }
    if (typeof value.logprobs === "boolean") controls.logprobs = value.logprobs;
    if (typeof value.stop === "string" || (Array.isArray(value.stop) && value.stop.every((item) => typeof item === "string")))
      controls.stop = value.stop as string | readonly string[];
    const requestedReasoning = value.reasoning_effort ?? value.reasoning_level;
    const reasoningEfforts = new Set<NonNullable<ReasoningIntent["effort"]>>([
      "none", "minimal", "low", "medium", "high", "xhigh", "max",
    ]);
    const reasoning =
      typeof requestedReasoning === "string" && reasoningEfforts.has(requestedReasoning as NonNullable<ReasoningIntent["effort"]>)
        ? { effort: requestedReasoning as NonNullable<ReasoningIntent["effort"]> }
        : undefined;
    const cacheKey = value.prompt_cache_key;
    const cacheHint =
      (typeof cacheKey === "string" && cacheKey.length > 0) || value.cache_control === "auto"
        ? "stable_prefix" as const
        : undefined;
    if (typeof cacheKey === "string" && cacheKey.length > 0)
      controls["extension:prompt_cache_key"] = cacheKey;
    controls["extension:completion.prompt"] = value.prompt;
    if (typeof value.echo === "boolean") controls["extension:completion.echo"] = value.echo;
    if (typeof value.suffix === "string") controls["extension:completion.suffix"] = value.suffix;
    return {
      model: typeof value.model === "string" ? value.model : "",
      messages: prompts.map((prompt) => ({ role: "user", content: [textPart(prompt)] })),
      generation_controls: controls,
      stream: value.stream === true,
      source_surface: "completion",
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(cacheHint === undefined ? {} : { cache_hint: cacheHint }),
    };
  }

  encodeOutput(events: readonly CanonicalEvent[], options: CompletionEncodingOptions = {}): SurfaceOutput {
    const model = modelFor(events, options);
    const reason = stopReason(events);
    const response = {
      id: options.response_id ?? `cmpl-${crypto.randomUUID()}`,
      object: "text_completion",
      created: options.created ?? Math.floor(Date.now() / 1000),
      model,
      choices: [{ text: outputText(events, options), index: 0, logprobs: null, finish_reason: reason }],
      ...(usage(events) === undefined ? {} : { usage: usage(events) }),
    };
    return { bytes: TEXT_ENCODER.encode(JSON.stringify(response)), content_type: "application/json" };
  }
}

export const completionAdapter = new CompletionAdapter();
