/**
 * [OpenAI]-compatible /chat/completions request encoder: canonical → wire body.
 */
import type { CanonicalRequest, ResponseFormat } from "../../transport/canonical-model";
import { isRecord } from "../primitives";
import { markLatestBreakpoint } from "../../transport/translation/cache-controls";
import { pickWireSupportedControls } from "../../transport/translation/capabilities";
import {
  clampReasoningEffort,
  resolveSupportedReasoningEfforts,
} from "../../transport/translation/thinking";
import { isClaudeBillingHeaderText, resolveImageSource } from "../primitives";
import { resolvePromptCacheKey } from "../../providers/operations/session-resolution";

/**
 * OpenAI `input_audio.format` accepts only the discrete ids `wav`/`mp3`, never a
 * MIME type. The canonical `audio` part carries a `media_type`; map it here and
 * fall back to `mp3` (the canonical parser's own default) so a caller that
 * omitted the media type still produces a valid wire part.
 */
const AUDIO_MIME_TO_FORMAT: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  mp3: "mp3",
  wav: "wav",
};

function resolveAudioFormat(mediaType: unknown): string {
  if (typeof mediaType === "string") {
    const mapped = AUDIO_MIME_TO_FORMAT[mediaType.toLowerCase()];
    if (mapped !== undefined) return mapped;
  }
  return "mp3";
}

/**
 * Rebuilds an OpenAI `image_url` part, preserving `detail` when the caller set it.
 *
 * Chat Completions can only express an image as a URL — there is no `file_id`
 * form for images (unlike `file` parts) — so an image that carries only a
 * Files API reference has no valid Chat encoding. It degrades to a text
 * reference naming the id, which keeps the attachment visible to the model and
 * the request valid, instead of emitting an `image_url` the upstream rejects.
 */
function chatImagePart(payload: unknown): Record<string, unknown> | undefined {
  const source = resolveImageSource(payload);
  if (source?.url === undefined) return undefined;
  return {
    type: "image_url",
    image_url: {
      url: source.url,
      ...(source.detail === undefined ? {} : { detail: source.detail }),
    },
  };
}

/** Text fallback for an image the Chat wire cannot encode (a bare `file_id`). */
function chatImageReferenceText(payload: unknown): string {
  const source = resolveImageSource(payload);
  return source?.fileId === undefined
    ? "[image: unsupported source]"
    : `[image: ${source.fileId}]`;
}

/**
 * Projects the canonical response format onto the OpenAI Chat `json_schema`
 * envelope (`{type:"json_schema", json_schema:{name, description, schema, strict}}`),
 * retaining `name`/`description` that the canonical model now carries.
 */
function chatResponseFormat(format: ResponseFormat): Record<string, unknown> {
  if (format.type === "json_object") return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: {
      ...(format.name === undefined ? {} : { name: format.name }),
      ...(format.description === undefined ? {} : { description: format.description }),
      ...(format.schema === undefined ? {} : { schema: format.schema }),
      ...(format.strict === undefined ? {} : { strict: format.strict }),
    },
  };
}

/**
 * OpenAI `file` content part (`file_data`/`file_id`/`filename` nested under
 * `file`). The Chat wire has no URL field, so a reference-only document
 * (`source_type: "url"` / `"file"` without an inline payload) degrades to a
 * text part carrying the reference instead of a malformed empty `file` block.
 */
function chatFilePart(part: {
  data: unknown;
  filename?: string | undefined;
  file_id?: string | undefined;
  url?: string | undefined;
  source_type?: string | undefined;
}): Record<string, unknown> {
  const referenceOnly =
    part.source_type === "url" ||
    part.source_type === "file" ||
    (part.url !== undefined && part.data === part.url);
  const inlineData =
    !referenceOnly && part.data !== undefined && part.data !== null && part.data !== ""
      ? part.data
      : undefined;
  if (part.file_id !== undefined) {
    return {
      type: "file",
      file: {
        file_id: part.file_id,
        ...(part.filename === undefined ? {} : { filename: part.filename }),
      },
    };
  }
  if (inlineData !== undefined) {
    return {
      type: "file",
      file: {
        file_data: typeof inlineData === "string" ? inlineData : JSON.stringify(inlineData),
        ...(part.filename === undefined ? {} : { filename: part.filename }),
      },
    };
  }
  const reference =
    part.url ?? (typeof part.data === "string" && part.data.length > 0 ? part.data : undefined);
  return {
    type: "text",
    text: reference === undefined ? "[file: unsupported source]" : `[file: ${reference}]`,
  };
}

const CHAT_CACHEABLE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "text",
  "image_url",
  "input_audio",
  "file",
]);

/**
 * Marks the latest stable input block with an explicit prompt-cache breakpoint,
 * mirroring the OpenAI client behavior: anchor the block just before the most
 * recent user/developer turn so the cached prefix stays stable as the turn grows.
 */
function markLatestChatCacheBreakpoint(messages: Array<Record<string, unknown>>): void {
  markLatestBreakpoint(messages, {
    isInputItem: (item) => item["role"] === "user" || item["role"] === "developer",
    isCacheableRole: (role) => role === "user" || role === "developer" || role === "system",
    isCacheableBlock: (block) =>
      typeof block["type"] === "string" && CHAT_CACHEABLE_BLOCK_TYPES.has(block["type"]),
    writeMarker: (block) => (block["prompt_cache_breakpoint"] = { mode: "explicit" }),
  });
}

export function canonicalToChatPayload(
  request: CanonicalRequest,
  supportsPromptCaching = true,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (request.system?.length) {
    for (const p of request.system) {
      if (p.kind === "text" && !isClaudeBillingHeaderText(p.text))
        messages.push({ role: "system", content: p.text });
    }
  }
  if (request.instructions?.length) {
    for (const p of request.instructions) {
      if (p.kind === "text" && !isClaudeBillingHeaderText(p.text))
        messages.push({ role: "developer", content: p.text });
    }
  }
  for (const m of request.messages) {
    if (m.role === "assistant" && m.content.some((c) => c.kind === "toolCall")) {
      const toolCalls = m.content
        .filter((c): c is Extract<typeof c, { kind: "toolCall" }> => c.kind === "toolCall")
        .map((tc) => ({
          id: tc.call_id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments:
              typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
          },
        }));
      const textParts = m.content.filter(
        (c): c is Extract<typeof c, { kind: "text" }> => c.kind === "text",
      );
      const content = textParts.length ? textParts.map((c) => c.text).join("\n") : null;
      // Reasoning must survive on a tool-call turn, not just on plain assistant
      // turns. Providers in thinking mode require the previous turn's reasoning
      // to be replayed, and the tool-call turn is exactly where a thinking
      // model emits it — dropping it here made the next request fail with
      // "the reasoning content from the previous turn must be passed back in
      // thinking mode" (WorkBuddy/CodeBuddy 400). Chat Completions has no
      // reasoning content part, so it travels in the provider-native
      // `reasoning_content` side channel, same as the branches below.
      const reasoningContent = m.content
        .filter((c): c is Extract<typeof c, { kind: "reasoning" }> => c.kind === "reasoning")
        .map((c) => c.summary ?? (typeof c.payload === "string" ? c.payload : ""))
        .join("\n");
      // Gated on the *presence* of a reasoning part, not on non-empty text:
      // with `display: "omitted"` the provider emits a thinking block whose
      // text is empty but whose signature marks the turn as a thinking turn,
      // and the upstream still demands the field back. Omitting it there
      // reproduces the same 400, so an empty string is the correct value.
      const hasReasoning = m.content.some((c) => c.kind === "reasoning");
      messages.push({
        role: "assistant",
        content,
        tool_calls: toolCalls,
        ...(hasReasoning ? { reasoning_content: reasoningContent } : {}),
      });
    } else if (m.role === "tool") {
      for (const p of m.content) {
        if (p.kind === "toolResult") {
          const content = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
          // role:"tool" has no error-flag slot: prefix visibly instead of
          // silently converting a failure into an apparent success.
          messages.push({
            role: "tool",
            tool_call_id: p.call_id,
            content: p.is_error === true ? `[tool_error] ${content}` : content,
          });
        }
      }
    } else {
      // Tool results re-homed into role:"user" by the Messages ledger (every
      // claude-cli tool flow) must still reach the provider as role:"tool"
      // messages. Dropping them here breaks tool_call pairing downstream and
      // the upstream rejects the history with a tool-sequence 400. Same
      // error-flag shape as the role:"tool" branch above.
      for (const p of m.content) {
        if (p.kind !== "toolResult") continue;
        const resultContent = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
        messages.push({
          role: "tool",
          tool_call_id: p.call_id,
          content: p.is_error === true ? `[tool_error] ${resultContent}` : resultContent,
        });
      }
      const reasoningContent = m.content
        .filter((c): c is Extract<typeof c, { kind: "reasoning" }> => c.kind === "reasoning")
        .map((c) => c.summary ?? (typeof c.payload === "string" ? c.payload : ""))
        .join("\n");
      // Presence, not length: an `omitted`-display thinking block carries an
      // empty text with a signature, and the field is still required back.
      const hasReasoning = m.content.some((c) => c.kind === "reasoning");
      const hasRichContent = m.content.some(
        (c) => c.kind === "image" || c.kind === "file" || c.kind === "audio" || c.kind === "document",
      );
      if (hasRichContent) {
        // Reasoning never becomes a content part here: Chat Completions has no
        // reasoning part, so it travels in the provider-native
        // `reasoning_content` side channel attached to the message below.
        const parts: Array<Record<string, unknown>> = [];
        for (const p of m.content) {
          if (p.kind === "text") {
            parts.push({ type: "text", text: p.text });
          } else if (p.kind === "image") {
            const imagePart = chatImagePart(p.payload);
            parts.push(imagePart ?? { type: "text", text: chatImageReferenceText(p.payload) });
          } else if (p.kind === "document") {
            // OpenAI Chat Completions has no `document` content part, so a
            // document is carried as a `file` part — the provider-neutral shape
            // used for non-image attachments.
            parts.push(
              chatFilePart({
                data: p.data,
                file_id: p.file_id,
                url: p.url,
                source_type: p.source_type,
                ...(p.title === undefined ? {} : { filename: p.title }),
              }),
            );
          } else if (p.kind === "file") {
            // A canonical `file` part reaches here whenever the inbound surface
            // was Responses or Messages (`document` covers Anthropic-origin
            // documents, `file` covers Responses-origin ones). There was no
            // branch for it, so the attachment was silently dropped on the
            // Chat outbound path while `image`, `document` and `audio` all
            // survived — a cross-protocol move lost the file with no error.
            parts.push(
              chatFilePart({
                data: p.data,
                ...(p.file_id === undefined ? {} : { file_id: p.file_id }),
                ...(p.url === undefined ? {} : { url: p.url }),
                ...(p.filename === undefined ? {} : { filename: p.filename }),
              }),
            );
          } else if (p.kind === "audio") {
            parts.push({
              type: "input_audio",
              input_audio: { data: p.data, format: resolveAudioFormat(p.media_type) },
            });
          } else if (p.kind === "refusal") {
            parts.push({ type: "text", text: p.text });
          }
        }
        messages.push({
          role: m.role,
          content: parts,
          ...(m.role === "assistant" && hasReasoning
            ? { reasoning_content: reasoningContent }
            : {}),
        });
      } else {
        // A user turn whose toolResult parts were all folded out above has
        // nothing left to say: emitting it as an empty-content `user` message
        // right after the tool results breaks strict upstreams (a bare `user`
        // turn between a result and the next assistant turn reads as a broken
        // tool sequence — WorkBuddy/CodeBuddy `11148`). Fold the leftover
        // reasoning into the last tool message's side channel when one was
        // just emitted, and skip the turn otherwise; a turn that still
        // carries text or rich parts emits below as usual.
        const textParts = m.content.filter((p) => p.kind === "text");
        const hasText = textParts.some((p) => p.text.length > 0);
        if (!hasText && !hasRichContent) {
          // An assistant turn that carries reasoning but no text/tool call is
          // load-bearing: it is what a thinking model emits under
          // `display: "omitted"`, and dropping it stripped the replay the
          // provider demands on the next request. `reasoning_content` is an
          // assistant-only field, so it is emitted here and nowhere else.
          if (m.role === "assistant" && hasReasoning) {
            messages.push({
              role: "assistant",
              content: "",
              reasoning_content: reasoningContent,
            });
            continue;
          }
          if (m.role !== "assistant" && hasReasoning && reasoningContent.length > 0) {
            const last = messages[messages.length - 1];
            if (last !== undefined && last["role"] === "tool") {
              last["reasoning_content"] = reasoningContent;
            }
          }
          continue;
        }
        const content = m.content
          .map((p) => {
            if (p.kind === "text") return p.text;
            if (p.kind === "reasoning") return undefined;
            if (p.kind === "refusal") return p.text;
            return "";
          })
          .filter((text): text is string => text !== undefined)
          .join("\n");
        messages.push({
          role: m.role,
          content,
          ...(m.role === "assistant" && hasReasoning
            ? { reasoning_content: reasoningContent }
            : {}),
        });
      }
    }
  }
  if (
    supportsPromptCaching &&
    request.cache_hint !== undefined &&
    request.cache_hint !== "stable_prefix" &&
    request.cache_hint.list.length > 0
  ) {
    markLatestChatCacheBreakpoint(messages);
  }
  const payload: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: request.stream,
  };
  const chatCacheKey = resolvePromptCacheKey(request);
  if (supportsPromptCaching && chatCacheKey !== undefined)
    payload.prompt_cache_key = chatCacheKey;
  if (request.tools?.length) {
    payload["tools"] = request.tools.map((t) => {
      if (t.tool_type === "custom") {
        return {
          type: "custom",
          custom: {
            name: t.name,
            ...(t.description === undefined ? {} : { description: t.description }),
            ...(isRecord(t.jsonSchema) && Object.keys(t.jsonSchema).length > 0
              ? { format: t.jsonSchema }
              : {}),
          },
        };
      }
      if (t.tool_type !== undefined && t.tool_type !== "function" && isRecord(t.jsonSchema))
        return t.jsonSchema;
      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.jsonSchema,
          strict: t.strict,
          ...(t.input_examples === undefined ? {} : { input_examples: t.input_examples }),
          ...(t.defer_loading === undefined ? {} : { defer_loading: t.defer_loading }),
          ...(t.allowed_callers === undefined ? {} : { allowed_callers: t.allowed_callers }),
        },
      };
    });
  }
  if (request.tool_choice) {
    if (typeof request.tool_choice === "object" && request.tool_choice.type === "allowed_tools") {
      payload["tool_choice"] = {
        type: "allowed_tools",
        mode: request.tool_choice.mode,
        tools: request.tool_choice.names.map((name) => ({ type: "function", function: { name } })),
      };
    } else if (typeof request.tool_choice === "object" && request.tool_choice.type === "custom") {
      payload["tool_choice"] = { type: "custom", custom: { name: request.tool_choice.name } };
    } else if (typeof request.tool_choice === "object" && request.tool_choice.type === "tool") {
      payload["tool_choice"] = { type: "function", function: { name: request.tool_choice.name } };
    } else {
      payload["tool_choice"] = request.tool_choice;
    }
  }
  if (request.response_format) payload["response_format"] = chatResponseFormat(request.response_format);
  // OpenAI reasoning effort is a top-level Chat parameter, distinct from the
  // provider-native `thinking` object the Anthropic wire uses.
  if (request.reasoning?.effort !== undefined) {
    const effort = clampReasoningEffort(
      request.reasoning.effort,
      resolveSupportedReasoningEfforts(request.model, "chat"),
    );
    if (effort !== undefined) payload["reasoning_effort"] = effort;
  }
  // Stream controls the caller asked for are forwarded upstream so a
  // pass-through provider can honor them (the local encoder honors them too).
  const includeUsage = request.generation_controls["extension:include_usage"];
  const includeObfuscation = request.generation_controls["extension:include_obfuscation"];
  if (typeof includeUsage === "boolean" || typeof includeObfuscation === "boolean") {
    payload["stream_options"] = {
      ...(typeof includeUsage === "boolean" ? { include_usage: includeUsage } : {}),
      ...(typeof includeObfuscation === "boolean" ? { include_obfuscation: includeObfuscation } : {}),
    };
  }
  const modalities = request.generation_controls["extension:modalities"];
  if (Array.isArray(modalities)) payload["modalities"] = modalities;
  const audio = request.generation_controls["extension:audio"];
  if (isRecord(audio)) payload["audio"] = audio;
  const metadata = request.generation_controls["extension:metadata"];
  if (isRecord(metadata)) payload["metadata"] = metadata;
  const user = request.generation_controls["extension:user"];
  if (typeof user === "string") payload["user"] = user;
  // Remaining documented top-level Chat parameters, forwarded verbatim when
  // the caller supplied them (they have no canonical generation-control slot).
  const passthrough: ReadonlyArray<readonly [string, string]> = [
    ["extension:store", "store"],
    ["extension:prediction", "prediction"],
    ["extension:moderation", "moderation"],
    ["extension:safety_identifier", "safety_identifier"],
    ["extension:verbosity", "verbosity"],
    ["extension:web_search_options", "web_search_options"],
    ["extension:frequency_penalty", "frequency_penalty"],
    ["extension:presence_penalty", "presence_penalty"],
    ["extension:logit_bias", "logit_bias"],
    ["extension:prompt_cache_options", "prompt_cache_options"],
    ["extension:prompt_cache_retention", "prompt_cache_retention"],
  ];
  for (const [extension, field] of passthrough) {
    const value = request.generation_controls[extension as `extension:${string}`];
    if (value !== undefined) payload[field] = value;
  }
  Object.assign(payload, pickWireSupportedControls(request.generation_controls, "chat"));
  return payload;
}
