/**
 * Canonical → Claude Messages request builder.
 */
import type { CanonicalRequest, ContentPart } from "../../transport/canonical-model";
import { buildAnthropicThinkingPayload } from "../../providers/reasoning";
import { anthropicCacheControl } from "../../transport/translation/cache-controls";
import {
  THINKING_STRIPPED_SAMPLING_CONTROLS,
  ensureMaxTokensForThinking,
  isThinkingEnabled,
} from "../../transport/translation/capabilities";
import {
  isClaudeBillingHeaderText,
  normalizeAnthropicToolCallId,
  parseArguments,
  prefixClaudeToolName,
  sanitizeSchemaForAnthropic,
  stringValue,
  toWellFormedDeep,
  toWellFormedString,
  type ClaudeWireObject,
  isRecord,
  resolveImageSource,
} from "../primitives";
import { log } from "../../observability/logger";
import { clampReasoningEffort, resolveSupportedReasoningEfforts } from "../../transport/translation/thinking";

export const OAUTH_MESSAGES_MAX_OUTPUT_TOKENS = 64_000;

/**
 * Gateway default when the caller sent no max_tokens (Anthropic requires
 * the field). Explicit and warned at the call site — never silent.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4_096;

/** Anthropic Messages' documented base64-image media-type allowlist. */
const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Common aliases that resolve to a supported Anthropic media type. */
const IMAGE_MEDIA_TYPE_ALIASES: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Normalizes a base64 image block's `media_type` (aliases like `jpg`→`jpeg`)
 * and validates it against Anthropic's supported set, logging — rather than
 * silently forwarding — an unsupported spelling (gap report P14).
 */
function normalizeAnthropicImageMediaType(mediaType: string): string {
  const lower = mediaType.toLowerCase();
  const normalized = ANTHROPIC_IMAGE_MEDIA_TYPES.has(lower)
    ? lower
    : (IMAGE_MEDIA_TYPE_ALIASES[lower] ?? lower);
  if (!ANTHROPIC_IMAGE_MEDIA_TYPES.has(normalized)) {
    log.warn(
      `claude: unsupported image media_type "${mediaType}", forwarding as-is`,
      {
        media_type: mediaType,
      },
    );
    return mediaType;
  }
  return normalized;
}

/**
 * Splits an RFC 2397 `data:` URL into Anthropic's `{media_type, data}` base64
 * source. Returns `undefined` for a non-data URL, or for a data URL whose
 * payload is not base64 (Anthropic's `source` has no other transport).
 */
function base64FromDataUrl(url: string): { media_type: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  const mediaType = match?.[1];
  const data = match?.[2];
  if (mediaType === undefined || data === undefined || data.length === 0) return undefined;
  return { media_type: mediaType, data };
}

/**
 * Projects a canonical image part onto an Anthropic `image` block.
 *
 * Anthropic's `source.type` is a closed set — `base64` | `url` | `file` — and
 * the upstream rejects anything else. A canonical image part is an opaque
 * origin payload, so it can arrive in a vocabulary that is *not* Anthropic's:
 * a Responses part carries `type: "input_image"` with a top-level `image_url`
 * string, and a Chat part carries a nested `image_url` object. Both used to be
 * forwarded with their own `type` intact (or with no `source` at all), so a
 * Responses- or Chat-origin image sent to a Claude model produced
 * `source.type: "input_image"` — an invalid block the provider refused.
 *
 * Every shape now collapses to a valid source, preferring the cheapest
 * transport: a Files API reference, then a URL, then base64 bytes (a `data:`
 * URL is split rather than embedded, because Anthropic has no data-URL field).
 */
function normalizeImageBlock(payload: unknown): ClaudeWireObject {
  // A bare string payload (a tolerant Chat parse of `image_url: "…"`) is a URL,
  // not a source object. Anthropic has no string source, so it is projected
  // like any other origin shape instead of being passed through as `source`.
  if (!isRecord(payload)) {
    const resolved = resolveImageSource(payload);
    if (resolved?.url !== undefined) {
      const split = base64FromDataUrl(resolved.url);
      return {
        type: "image",
        source:
          split !== undefined
            ? { type: "base64", media_type: split.media_type, data: split.data }
            : { type: "url", url: resolved.url },
      };
    }
    if (resolved?.fileId !== undefined) {
      return { type: "image", source: { type: "file", file_id: resolved.fileId } };
    }
    return { type: "image", source: payload };
  }
  const rawSource = isRecord(payload["source"]) ? payload["source"] : payload;
  if (!isRecord(rawSource)) return payload;

  // A `source` that is already Anthropic-shaped keeps its own fields; anything
  // else is re-projected from whichever origin vocabulary it arrived in.
  const sourceIsAnthropic = ["base64", "url", "file"].includes(String(rawSource["type"]));
  const source: Record<string, unknown> = sourceIsAnthropic ? { ...rawSource } : {};
  if (!sourceIsAnthropic) {
    const fileId = rawSource["file_id"];
    // A nested `image_url` (Chat) may itself be a string or `{url}`.
    const nested = rawSource["image_url"];
    const nestedUrl = isRecord(nested) ? nested["url"] : nested;
    const url = typeof nestedUrl === "string" ? nestedUrl : rawSource["url"];
    const inlineData = rawSource["data"];
    if (typeof fileId === "string") {
      source["type"] = "file";
      source["file_id"] = fileId;
    } else if (typeof url === "string") {
      const split = base64FromDataUrl(url);
      if (split !== undefined) {
        source["type"] = "base64";
        source["media_type"] = split.media_type;
        source["data"] = split.data;
      } else {
        source["type"] = "url";
        source["url"] = url;
      }
    } else if (typeof inlineData === "string") {
      source["type"] = "base64";
      source["media_type"] = typeof rawSource["media_type"] === "string" ? rawSource["media_type"] : "image/png";
      source["data"] = inlineData;
    }
    // `detail` is an OpenAI hint with no Anthropic equivalent; it is dropped
    // rather than forwarded, since the upstream rejects unknown source fields.
  }
  if (typeof source["media_type"] === "string") {
    source["media_type"] = normalizeAnthropicImageMediaType(source["media_type"]);
  }
  // A source still lacking a valid discriminator cannot be repaired into one;
  // preserve the origin payload rather than fabricating a transport.
  if (!["base64", "url", "file"].includes(String(source["type"]))) {
    return rawSource === payload ? { type: "image", source } : { ...payload, source };
  }
  return rawSource === payload
    ? { type: "image", source }
    : { ...payload, source };
}

/**
 * Projects a canonical file part onto Anthropic's `document.source`, preferring
 * the Files API reference over an inlined base64 payload so a replayed
 * `file_id` is not re-uploaded as bytes.
 */
function anthropicFileSource(part: Extract<ContentPart, { kind: "file" }>): ClaudeWireObject {
  if (part.file_id !== undefined) return { type: "file", file_id: part.file_id };
  if (
    part.url !== undefined &&
    (part.data === undefined || part.data === null || part.data === "" || part.data === part.url)
  ) {
    return { type: "url", url: part.url };
  }
  return { type: "base64", media_type: part.media_type, data: part.data };
}

/** Projects a canonical document part onto Anthropic's `document.source`. */
function anthropicDocumentSource(
  part: Extract<ContentPart, { kind: "document" }>,
): ClaudeWireObject {
  if (part.source_type === "url" && part.url !== undefined) return { type: "url", url: part.url };
  if (part.source_type === "file" && part.file_id !== undefined)
    return { type: "file", file_id: part.file_id };
  if (part.source_type === "text")
    return { type: "text", media_type: part.media_type, data: part.data };
  return { type: "base64", media_type: part.media_type, data: part.data };
}

function partToClaudeBlock(
  part: ContentPart,
  ctx?: { seen: Map<string, number>; idMap: Map<string, string>; isOAuth: boolean },
): ClaudeWireObject | undefined {
  switch (part.kind) {
    case "text":
      return { type: "text", text: toWellFormedString(part.text) };
    case "image":
      return normalizeImageBlock(part.payload);
    case "file":
      return {
        type: "document",
        source: anthropicFileSource(part),
        ...(part.filename === undefined ? {} : { title: part.filename }),
      };
    case "document":
      return {
        type: "document",
        source: anthropicDocumentSource(part),
        ...(part.title === undefined ? {} : { title: part.title }),
        ...(part.citations === undefined ? {} : { citations: { enabled: part.citations } }),
      };
    case "audio":
      // The Messages wire defines no audio content block, so there is nothing
      // to encode here — see `AUDIO_CAPABLE_WIRE_FAMILIES`, which denies audio
      // to this wire so the request degrades before it reaches this builder.
      // Emitting the part anyway would put an undefined block type on the wire
      // and fail the whole request; degrade to the same visible placeholder the
      // capability path uses, so an unexpected part loses only the attachment.
      return { type: "text", text: "[audio]" };
    case "refusal":
      return { type: "text", text: toWellFormedString(part.text) };
    case "toolCall": {
      const seen = ctx?.seen ?? new Map<string, number>();
      const idMap = ctx?.idMap ?? new Map<string, string>();
      const normalized = normalizeAnthropicToolCallId(part.call_id, seen);
      idMap.set(part.call_id, normalized);
      return {
        type: "tool_use",
        id: normalized,
        name: prefixClaudeToolName(part.name, ctx?.isOAuth ?? false),
        input: toWellFormedDeep(parseArguments(part.arguments)),
        ...(part.index === undefined ? {} : { index: part.index }),
      };
    }
    case "toolResult": {
      const seen = ctx?.seen;
      const idMap = ctx?.idMap;
      let normalizedId = part.call_id;
      if (idMap?.has(part.call_id)) {
        normalizedId = idMap.get(part.call_id) as string;
      } else if (seen) {
        normalizedId = normalizeAnthropicToolCallId(part.call_id, seen);
        idMap?.set(part.call_id, normalizedId);
      } else {
        normalizedId = normalizeAnthropicToolCallId(part.call_id);
      }
      const content =
        typeof part.content === "string"
          ? toWellFormedString(part.content)
          : part.content.flatMap((p) => {
              const block = partToClaudeBlock(p, ctx);
              return block === undefined ? [] : [block];
            });
      return {
        type: "tool_result",
        tool_use_id: normalizedId,
        content,
        ...(part.is_error === true ? { is_error: true } : {}),
      };
    }
    case "reasoning":
      if (
        !part.opaque &&
        (typeof part.signature !== "string" || part.signature.trim().length === 0)
      ) {
        const text = part.summary ?? (stringValue(part.payload) ? part.payload : "");
        return text.length > 0 ? { type: "text", text: toWellFormedString(text) } : undefined;
      }
      if (part.opaque) {
        return isRecord(part.payload)
          ? (toWellFormedDeep(part.payload) as ClaudeWireObject)
          : { type: "redacted_thinking", data: toWellFormedDeep(part.payload) };
      }
      return {
        type: "thinking",
        thinking: toWellFormedString(
          part.summary ?? (stringValue(part.payload) ? part.payload : ""),
        ),
        ...(part.signature === undefined
          ? {}
          : { signature: toWellFormedString(part.signature) }),
      };
    case "extension": {
      // Only Messages-native extensions survive onto the Anthropic wire:
      // server blocks pass through verbatim and `messages:*` types strip to
      // their native block shape. Foreign-surface annotations
      // (`responses:*`, chat `audio`/obfuscation, `unknown`) have no Messages
      // representation — forwarding them would draw an upstream 400 for an
      // unknown block type. The Chat/Responses request builders degrade
      // extensions away the same way, so this matches house convention.
      if (!isRecord(part.payload)) return undefined;
      if (
        part.name === "server_tool_use" ||
        part.name === "search_result" ||
        part.name === "document" ||
        (part.name.startsWith("messages:") && part.name !== "messages:unknown")
      )
        return toWellFormedDeep(part.payload) as ClaudeWireObject;
      return undefined;
    }
  }
}

function canonicalToolChoice(value: CanonicalRequest["tool_choice"]): unknown {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "none") return { type: value };
  if (value === "required") return { type: "any" };
  if (value.type === "tool") return { type: "tool", name: value.name };
  // Anthropic Messages has no custom-tool choice; the closest wire contract is
  // a forced named tool, which preserves "call this tool" intent.
  if (value.type === "custom") return { type: "tool", name: value.name };
  return {
    type: value.type,
    mode: value.mode,
    tools: value.names.map((name) => ({ type: "tool", name })),
  };
}

function stablePartitionToolUse(blocks: ClaudeWireObject[]): void {
  let sawToolUse = false;
  let needsPartition = false;
  for (const block of blocks) {
    if (isRecord(block) && block.type === "tool_use") sawToolUse = true;
    else if (sawToolUse) {
      needsPartition = true;
      break;
    }
  }
  if (!needsPartition) return;
  const nonToolUse: ClaudeWireObject[] = [];
  const toolUse: ClaudeWireObject[] = [];
  for (const block of blocks) {
    if (isRecord(block) && block.type === "tool_use") toolUse.push(block);
    else nonToolUse.push(block);
  }
  blocks.length = 0;
  blocks.push(...nonToolUse, ...toolUse);
}

export function canonicalToClaudeMessagesPayload(
  request: CanonicalRequest,
  options: { isOAuth?: boolean } = {},
): ClaudeWireObject {
  const seen = new Map<string, number>();
  const idMap = new Map<string, string>();
  const ctx = { seen, idMap, isOAuth: options.isOAuth ?? false };
  const messages: ClaudeWireObject[] = [];
  // Anthropic accepts system content only at the top level. Chat `developer`
  // turns and Responses `instructions` have no `developer` role upstream, and
  // a Responses-origin request can carry `system`/`developer` turns inside
  // `messages[]`; hoist all of them into the top-level system block.
  const hoistedSystem: ContentPart[] = [];
  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      hoistedSystem.push(...message.content);
      continue;
    }
    // tool_result content (text, images, …) encodes natively via
    // partToClaudeBlock: no turn restructuring, no invented filler text.
    // Foreign extensions filter out (they would 400 upstream); see the
    // `extension` case above.
    const content = message.content.flatMap((p) => {
      const block = partToClaudeBlock(p, ctx);
      return block === undefined ? [] : [block];
    });
    // Stable-partition so all tool_use blocks trail non-tool content (S6)
    // Anthropic rejects tool_use ids that don't immediately precede tool_results.
    if (message.role === "assistant" && Array.isArray(content)) {
      stablePartitionToolUse(content as ClaudeWireObject[]);
    }
    messages.push({
      role: message.role === "tool" ? "user" : message.role,
      content,
    });
  }
  // Caller-driven cache breakpoints only: no implicit TTL/scope is added,
  // so Anthropic's own 5m default applies unless the caller asked otherwise.
  const messagesCache = anthropicCacheControl(request.cache_hint);
  if (messages.length > 0 && messagesCache.cache_control) {
    const last = messages[messages.length - 1];
    const blocks = last && Array.isArray(last.content) ? last.content : [];
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (
        isRecord(block) &&
        block.type !== "thinking" &&
        block.type !== "redacted_thinking" &&
        block.type !== "fallback" &&
        block.type !== "tool_addition" &&
        block.type !== "tool_removal"
      ) {
        blocks[index] = {
          ...block,
          cache_control: messagesCache.cache_control,
        };
        break;
      }
    }
  }
  const isOAuth = options.isOAuth ?? false;
  // Anthropic requires max_tokens: the caller's value wins, widened to the
  // tool-call floor when tools are present (narrow defaults truncate real
  // tool arguments), absent values fall back to the documented default.
  // OAuth is clamped to the known CLI ceiling; API-key stays verbatim so an
  // over-limit value surfaces as an honest upstream error.
  const TOOL_CALL_MAX_TOKENS_FLOOR = 32_000;
  const requestedMax = request.generation_controls.max_tokens;
  const hasTools = (request.tools?.length ?? 0) > 0;
  let maxTokens = requestedMax ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
  if (requestedMax === undefined) {
    log.warn("claude: max_tokens absent, defaulting", {
      max_tokens: maxTokens,
    });
  }
  if (hasTools && maxTokens < TOOL_CALL_MAX_TOKENS_FLOOR) {
    log.warn("claude: max_tokens floored for tool calls", {
      requested: maxTokens,
      floor: TOOL_CALL_MAX_TOKENS_FLOOR,
    });
    maxTokens = TOOL_CALL_MAX_TOKENS_FLOOR;
  }
  if (isOAuth) maxTokens = Math.min(maxTokens, OAUTH_MESSAGES_MAX_OUTPUT_TOKENS);
  const thinkingEnabled = isThinkingEnabled(request);
  if (thinkingEnabled && request.reasoning?.budget_tokens !== undefined) {
    maxTokens = ensureMaxTokensForThinking(
      maxTokens,
      request.reasoning.budget_tokens,
      Number.MAX_SAFE_INTEGER,
    );
  }
  const payload: ClaudeWireObject = {
    model: request.model,
    max_tokens: maxTokens,
    messages,
    stream: request.stream,
  };
  const systemParts: ContentPart[] = [
    ...(request.system ?? []),
    ...(request.instructions ?? []),
    ...hoistedSystem,
  ];
  if (systemParts.length > 0) {
    // Drop echoed billing attestations from replayed history: they attest a
    // different body and must never be forwarded upstream again.
    const system = systemParts.filter(
      (p) => p.kind !== "text" || !isClaudeBillingHeaderText(p.text),
    );
    if (system.length > 0)
      payload.system = system.flatMap((p) => {
        const block = partToClaudeBlock(p, ctx);
        return block === undefined ? [] : [block];
      });
  }
  if (request.tools?.length) {
    payload.tools = request.tools.map((tool) => ({
      name: prefixClaudeToolName(tool.name, isOAuth),
      ...(tool.description === undefined
        ? {}
        : { description: toWellFormedDeep(tool.description) }),
      input_schema: sanitizeSchemaForAnthropic(tool.jsonSchema),
      ...(tool.strict === true ? { strict: true } : {}),
      ...(tool.eager_input_streaming === undefined
        ? {}
        : { eager_input_streaming: tool.eager_input_streaming }),
      ...(tool.defer_loading === undefined
        ? {}
        : { defer_loading: tool.defer_loading }),
      ...(tool.input_examples === undefined ? {} : { input_examples: tool.input_examples }),
      ...(tool.allowed_callers === undefined ? {} : { allowed_callers: tool.allowed_callers }),
    }));
  }
  const rawToolChoice = canonicalToolChoice(request.tool_choice);
  if (isRecord(rawToolChoice) && rawToolChoice.type === "tool" && stringValue(rawToolChoice.name)) {
    rawToolChoice.name = prefixClaudeToolName(rawToolChoice.name, isOAuth);
  }
  const parallelToolCallsDisabled =
    request.generation_controls.parallel_tool_calls === false;
  if (rawToolChoice !== undefined || parallelToolCallsDisabled) {
    const baseChoice = rawToolChoice as Record<string, unknown> | undefined;
    const choice: Record<string, unknown> = baseChoice
      ? { ...baseChoice }
      : { type: "auto" };
    if (parallelToolCallsDisabled) choice.disable_parallel_tool_use = true;
    payload.tool_choice = choice;
  }
  if (messagesCache.cache_control) {
    const system = Array.isArray(payload.system) ? payload.system : [];
    const lastSystem = system.at(-1);
    if (isRecord(lastSystem)) {
      system[system.length - 1] = { ...lastSystem, cache_control: messagesCache.cache_control };
    }
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const lastTool = tools.at(-1);
    if (isRecord(lastTool)) {
      tools[tools.length - 1] = { ...lastTool, cache_control: messagesCache.cache_control };
    }
  }
  const controls = request.generation_controls;
  // Strip sampling params when thinking is active (P11) — Anthropic rejects
  // them for enabled/adaptive. The stripped set is owned by capabilities.ts.
  const thinkingStripped = thinkingEnabled ? THINKING_STRIPPED_SAMPLING_CONTROLS : undefined;
  if (controls.temperature !== undefined && !thinkingStripped?.includes("temperature"))
    payload.temperature = controls.temperature;
  if (controls.top_p !== undefined && !thinkingStripped?.includes("top_p"))
    payload.top_p = controls.top_p;
  if (controls.top_k !== undefined && !thinkingStripped?.includes("top_k"))
    payload.top_k = controls.top_k;
  if (controls.stop !== undefined) {
    // Both wires cap stop sequences at 4 (Anthropic mirrors the OpenAI
    // contract here): trim with a warning rather than letting the upstream
    // 400 the whole request.
    const stopList = Array.isArray(controls.stop)
      ? [...controls.stop]
      : [controls.stop];
    const maxStop = 4;
    if (stopList.length > maxStop) {
      log.warn(`claude: stop_sequences exceeds ${maxStop}; extra entries dropped`, {
        received: stopList.length,
        kept: maxStop,
      });
    }
    payload.stop_sequences = stopList
      .slice(0, maxStop)
      .map((s) => toWellFormedString(String(s)));
  }
  if (request.reasoning) {
    payload.thinking = buildAnthropicThinkingPayload(request.reasoning);
    const thinkingType = request.reasoning.thinking_type ?? "adaptive";
    if (thinkingType === "enabled" || thinkingType === "adaptive") {
      // The reference client sends context_management by default on every
      // thinking request (keeping the replayed thinking chain + KV cache);
      // a caller-supplied policy wins over the default.
      const supplied = controls["extension:context_management"];
      payload.context_management = isRecord(supplied)
        ? supplied
        : { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
    }
    // output_config plumbing: effort/task_budget when present. `thinking_display`
    // is NOT a wire field — display rides on `thinking.display` above.
    // Clamp to the model's published ladder exactly like the chat/Responses
    // codecs: an out-of-ladder tier is an upstream 4xx.
    const effort = clampReasoningEffort(
      request.reasoning.effort,
      resolveSupportedReasoningEfforts(request.model, "messages"),
    );
    const taskBudget = request.reasoning.task_budget;
    if (effort !== undefined || taskBudget !== undefined) {
      const outputConfig: Record<string, unknown> = {};
      // "none" disables reasoning rather than selecting a tier: the clamp
      // above already maps it to `undefined` (several upstreams 400 on a
      // literal none) instead of forwarding a value the wire rejects.
      if (effort !== undefined) outputConfig.effort = effort;
      if (taskBudget !== undefined) outputConfig.task_budget = taskBudget;
      if (Object.keys(outputConfig).length > 0)
        payload.output_config = outputConfig;
    }
  }
  const container = controls["extension:container"];
  if (isRecord(container)) payload.container = container;
  const inferenceGeo = controls["extension:inference_geo"];
  if (stringValue(inferenceGeo)) payload.inference_geo = inferenceGeo;
  const serviceTier = controls["extension:service_tier"];
  if (serviceTier === "auto" || serviceTier === "standard_only")
    payload.service_tier = serviceTier;
  const userProfileId = controls["extension:user_profile_id"];
  if (stringValue(userProfileId)) payload.user_profile_id = userProfileId;
  const workspaceId = controls["extension:workspace_id"];
  if (stringValue(workspaceId)) payload.workspace_id = workspaceId;
  // Messages reports token counts only when asked. A streaming custom
  // Anthropic-compatible provider otherwise ends with no usage frame, so the
  // request records input 0 / output 0 even though the model ran.
  if (request.stream) payload.stream_options = { include_usage: true };
  return payload;
}

