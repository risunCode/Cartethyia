import type { CanonicalMessage, ContentPart, GenerationControls } from "../../canonical-model";
import type { SurfaceInput } from "../adapters";
import { isRecord } from "../../../protocol/primitives";
import { textPart } from "../content-parts";
import { SERVICE_TIERS } from "../dialects";
import { readNumber, readString } from "../../../protocol/primitives";
import type { OpenAiUsage } from "../../../providers/usage";

export interface ChatEncodeOptions {
  response_id?: string;
  responseId?: string;
  model?: string;
  created?: number;
  service_tier?: string;
  serviceTier?: string;
  include_usage?: boolean;
  includeUsage?: boolean;
  include_obfuscation?: boolean;
  includeObfuscation?: boolean;
  /** A proxied obfuscation value; strings and bytes are relayed unchanged. */
  obfuscation?: string | Uint8Array;
  /** Padding to use for locally assembled chunks. */
  padding?: string | Uint8Array;
  /** A caller cancellation state; aborted streams never receive synthetic usage. */
  cancelled?: boolean;
  aborted?: boolean;
  signal?: AbortSignal;
}

export interface JsonObject {
  [key: string]: unknown;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
  index: number;
}

// Tool-call index pinning + arguments accumulation live in the shared
// `ToolCallTracker` (transport/tool-identity.ts), also used by the Messages
// ledger — this surface keeps only its wire encoding.

export interface ChunkBase {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: unknown[];
  usage: OpenAiUsage | null;
  service_tier?: string;
  obfuscation?: string;
}



export function isSurfaceInput(value: unknown): value is SurfaceInput {
  return isRecord(value) && "body" in value && "path" in value && typeof value.path === "string";
}

export function decodeBody(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(value)) as unknown;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as unknown;
  }
  return value;
}

export function requestBody(input: unknown): unknown {
  return decodeBody(isSurfaceInput(input) ? input.body : input);
}

export function nonNegativeNumber(value: unknown): number | undefined {
  const number = typeof value === "number" && Number.isFinite(value) ? value : undefined;
  return number !== undefined && number >= 0 ? number : undefined;
}

/** OpenAI discrete audio format ids ↔ the canonical MIME media type. */
const AUDIO_FORMAT_MEDIA_TYPE: Readonly<Record<string, string>> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
};

export function audioFormatToMediaType(format: string | undefined): string {
  if (format === undefined || format.length === 0) return "audio/mpeg";
  if (format.includes("/")) return format;
  return AUDIO_FORMAT_MEDIA_TYPE[format.toLowerCase()] ?? "audio/mpeg";
}

export function parseContentPart(value: unknown): ContentPart {
  if (typeof value === "string") return textPart(value);
  if (!isRecord(value)) {
    throw new Error("Malformed content part: expected string or object");
  }

  const type = readString(value, "type");
  if (type === "text" || type === "input_text" || type === "output_text") {
    const text = readString(value, "text");
    if (text === undefined) throw new Error("Malformed content part: text block requires text");
    return textPart(text);
  }
  if (type === "image_url" || type === "image") {
    return { kind: "image", payload: value.image_url ?? value };
  }
  if (type === "input_audio" || type === "audio") {
    // OpenAI Chat nests the payload under `input_audio`; tolerate a flat
    // `{data, format|media_type}` shape for Responses-origin blocks.
    const nested = isRecord(value.input_audio) ? value.input_audio : value;
    const format = readString(nested, "format") ?? readString(nested, "media_type");
    return {
      kind: "audio",
      data: nested.data ?? nested.audio ?? "",
      media_type: audioFormatToMediaType(format),
    };
  }
  if (type === "file" || type === "input_file" || type === "output_file") {
    // OpenAI Chat/Responses nest the payload under `file`; tolerate a flat
    // `{file_data, file_id, filename}` shape as well.
    const nested = isRecord(value.file) ? value.file : value;
    const filename = readString(nested, "filename");
    const fileId = readString(nested, "file_id");
    const url = readString(nested, "file_url") ?? readString(nested, "url");
    const mediaType =
      readString(nested, "mime_type") ?? readString(nested, "media_type") ?? "application/octet-stream";
    return {
      kind: "file",
      data: nested.file_data ?? nested.data ?? url ?? "",
      media_type: mediaType,
      ...(filename === undefined ? {} : { filename }),
      ...(fileId === undefined ? {} : { file_id: fileId }),
      ...(url === undefined ? {} : { url }),
    };
  }
  if (type === "document") {
    const source = isRecord(value.source) ? value.source : value;
    return {
      kind: "document",
      data: (isRecord(source) ? (source.data ?? source.file_id ?? source.url ?? "") : "") as string,
      media_type: (isRecord(source) && typeof source.media_type === "string" ? source.media_type : typeof value.mime_type === "string" ? value.mime_type : "application/octet-stream") as string,
      ...(typeof value.title === "string" ? { title: value.title } : {}),
    };
  }
  // Reasoning replayed from another surface. The Messages wire calls it
  // `thinking`/`redacted_thinking`; the Responses wire nests it as a
  // `reasoning` content block. Both carry the model's prior chain of thought,
  // which a follow-up turn must keep rather than reject as malformed.
  if (type === "thinking" || type === "reasoning") {
    const text = readString(value, "thinking") ?? readString(value, "text") ?? readString(value, "summary");
    return {
      kind: "reasoning",
      payload: text ?? null,
      ...(text === undefined ? {} : { summary: text }),
    };
  }
  if (type === "redacted_thinking") {
    return { kind: "reasoning", payload: value, opaque: true };
  }
  throw new Error(`Malformed content part: unsupported type "${type ?? "unknown"}"`);
}

export function parseContent(value: unknown): ContentPart[] {
  if (typeof value === "string") return [textPart(value)];
  if (!Array.isArray(value)) return [];
  return value.map((part) => parseContentPart(part));
}

export function parseToolCall(value: unknown, index: number): ParsedToolCall | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value, "id");
  const type = readString(value, "type");
  const functionValue = isRecord(value.function) ? value.function : value;
  const name = readString(functionValue, "name");
  if (id === undefined || name === undefined) return undefined;
  if (type !== undefined && type !== "function") return undefined;
  // A history tool call without arguments is a zero-arg call, not a
  // malformed one: default to "{}" instead of dropping the call and
  // orphaning its paired result. An empty/whitespace string is normalized
  // too — the Messages wire requires `input` to be an object, and a raw ""
  // is not valid JSON for the Chat/Responses history either.
  const args = readString(functionValue, "arguments");
  return {
    id,
    name,
    arguments: args === undefined || args.trim().length === 0 ? "{}" : args,
    index,
  };
}

export function parseMessage(value: unknown): CanonicalMessage {
  if (!isRecord(value)) throw new Error("Malformed message: expected object");
  const role = readString(value, "role");
  if (
    role !== "system" &&
    role !== "developer" &&
    role !== "user" &&
    role !== "assistant" &&
    role !== "tool"
  ) {
    throw new Error(`Malformed message: unsupported role "${role ?? "unknown"}"`);
  }

  const content = parseContent(value.content);
  // Chat carries prior reasoning as a sibling string, not a content block.
  // Dropping it loses the chain of thought on every follow-up turn.
  if (role === "assistant") {
    const reasoning = readString(value, "reasoning_content");
    if (reasoning !== undefined && reasoning.length > 0) {
      content.unshift({ kind: "reasoning", payload: reasoning, summary: reasoning });
    }
  }
  if (role === "assistant" && Array.isArray(value.tool_calls)) {
    const toolCalls = value.tool_calls.flatMap((call, index) => {
      const parsed = parseToolCall(call, index);
      if (parsed === undefined) return [];
      return [
        {
          kind: "toolCall" as const,
          call_id: parsed.id,
          name: parsed.name,
          arguments: parsed.arguments,
          index: parsed.index,
        },
      ];
    });
    return { role, content: [...content, ...toolCalls] };
  }

  if (role === "tool") {
    const callId = readString(value, "tool_call_id");
    if (callId === undefined) return { role, content };
    return {
      role,
      content: [
        {
          kind: "toolResult",
          call_id: callId,
          content: typeof value.content === "string" ? value.content : content,
        },
      ],
    };
  }
  return { role, content };
}


export function addExtension(
  controls: GenerationControls,
  key: `extension:${string}`,
  value: unknown,
): void {
  if (value !== undefined) controls[key] = value;
}

export function parseGenerationControls(body: JsonObject): GenerationControls {
  const controls: GenerationControls = {};
  const numericFields = ["temperature", "top_p", "n", "top_logprobs", "seed"] as const;
  for (const field of numericFields) {
    const number = readNumber(body, field);
    if (number !== undefined) controls[field] = number;
  }
  if (typeof body.logprobs === "boolean") controls.logprobs = body.logprobs;
  // Drop-encrypted-reasoning flag: a top-level boolean the caller sets when it
  // wants the gateway to omit encrypted reasoning artifacts before dispatch.
  if (typeof body.omit_encrypted_reasoning === "boolean")
    addExtension(controls, "extension:omit_encrypted_reasoning", body.omit_encrypted_reasoning);
  if (typeof body.parallel_tool_calls === "boolean")
    controls.parallel_tool_calls = body.parallel_tool_calls;
  if (typeof body.service_tier === "string") controls.service_tier = body.service_tier;
  if (
    typeof body.stop === "string" ||
    (Array.isArray(body.stop) && body.stop.every((part) => typeof part === "string"))
  ) {
    controls.stop = body.stop as string | readonly string[];
  }
  const tokenLimit = nonNegativeNumber(body.max_tokens);
  const completionLimit = nonNegativeNumber(body.max_completion_tokens);
  if (tokenLimit !== undefined) controls.max_tokens = tokenLimit;
  if (completionLimit !== undefined) controls.max_completion_tokens = completionLimit;

  const streamOptions = isRecord(body.stream_options) ? body.stream_options : undefined;
  if (streamOptions) {
    if (typeof streamOptions.include_usage === "boolean")
      addExtension(controls, "extension:include_usage", streamOptions.include_usage);
    if (typeof streamOptions.include_obfuscation === "boolean") {
      addExtension(controls, "extension:include_obfuscation", streamOptions.include_obfuscation);
    }
  }
  if (body.user !== undefined) addExtension(controls, "extension:user", body.user);
  if (body.metadata !== undefined) addExtension(controls, "extension:metadata", body.metadata);
  // Penalty, token-bias, and cache-retention knobs have no canonical slot;
  // they pass through verbatim like the other OpenAI-specific Chat fields.
  const frequencyPenalty = readNumber(body, "frequency_penalty");
  if (frequencyPenalty !== undefined)
    addExtension(controls, "extension:frequency_penalty", frequencyPenalty);
  const presencePenalty = readNumber(body, "presence_penalty");
  if (presencePenalty !== undefined)
    addExtension(controls, "extension:presence_penalty", presencePenalty);
  if (isRecord(body.logit_bias)) addExtension(controls, "extension:logit_bias", body.logit_bias);
  if (isRecord(body.prompt_cache_options))
    addExtension(controls, "extension:prompt_cache_options", body.prompt_cache_options);
  if (typeof body.prompt_cache_retention === "string")
    addExtension(controls, "extension:prompt_cache_retention", body.prompt_cache_retention);
  // Audio output + the remaining documented top-level Chat parameters are
  // carried as extensions so the request builder can forward them verbatim.
  if (Array.isArray(body.modalities) && body.modalities.every((m) => typeof m === "string"))
    addExtension(controls, "extension:modalities", body.modalities);
  if (isRecord(body.audio)) addExtension(controls, "extension:audio", body.audio);
  if (typeof body.store === "boolean") addExtension(controls, "extension:store", body.store);
  if (isRecord(body.prediction)) addExtension(controls, "extension:prediction", body.prediction);
  if (isRecord(body.moderation)) addExtension(controls, "extension:moderation", body.moderation);
  if (typeof body.safety_identifier === "string")
    addExtension(controls, "extension:safety_identifier", body.safety_identifier);
  if (typeof body.verbosity === "string")
    addExtension(controls, "extension:verbosity", body.verbosity);
  if (isRecord(body.web_search_options))
    addExtension(controls, "extension:web_search_options", body.web_search_options);
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.length > 0)
    addExtension(controls, "extension:prompt_cache_key", body.prompt_cache_key);
  if (
    SERVICE_TIERS.has(String(body.service_tier)) === false &&
    typeof body.service_tier === "string"
  ) {
    addExtension(controls, "extension:service_tier", body.service_tier);
  }
  return controls;
}
