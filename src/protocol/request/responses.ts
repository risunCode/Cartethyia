/**
 * [OpenAI]-compatible /v1/responses request encoder: canonical → wire body.
 */
import type { CanonicalRequest } from "../../transport/canonical-model";
import { isRecord } from "../primitives";
import { markLatestBreakpoint } from "../../transport/translation/cache-controls";
import {
  normalizeGenerationControls,
  pickWireSupportedControls,
} from "../../transport/translation/capabilities";
import {
  clampReasoningEffort,
  resolveSupportedReasoningEfforts,
} from "../../transport/translation/thinking";
import { isClaudeBillingHeaderText, resolveImageSource } from "../primitives";
import { resolvePromptCacheKey } from "../../providers/operations/session-resolution";

const RESPONSES_CACHEABLE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "input_text",
  "output_text",
  "input_image",
  "input_file",
  "input_audio",
]);

/** Marks the latest stable input block with an explicit prompt-cache breakpoint. */
export function markLatestResponsesCacheBreakpoint(input: Array<Record<string, unknown>>): void {
  markLatestBreakpoint(input, {
    isInputItem: (item) =>
      item["type"] === "message" && (item["role"] === "user" || item["role"] === "developer"),
    isCacheableRole: (role) => role === "user" || role === "developer" || role === "system",
    isCacheableBlock: (block) =>
      typeof block["type"] === "string" && RESPONSES_CACHEABLE_BLOCK_TYPES.has(block["type"]),
    writeMarker: (block) => (block["prompt_cache_breakpoint"] = { mode: "explicit" }),
  });
}

/** Renders a canonical computer-use result as a Responses `computer_screenshot`. */
function computerOutputForWire(content: unknown): Record<string, unknown> {
  if (typeof content === "string") return { type: "computer_screenshot", image_url: content };
  if (Array.isArray(content)) {
    const image = content.find((part) => isRecord(part) && part.kind === "image");
    if (image !== undefined && isRecord(image) && isRecord(image.payload)) {
      const output: Record<string, unknown> = { type: "computer_screenshot" };
      const imageUrl = image.payload["image_url"] ?? image.payload["url"];
      const fileId = image.payload["file_id"];
      const detail = image.payload["detail"];
      if (imageUrl !== undefined) output["image_url"] = imageUrl;
      if (fileId !== undefined) output["file_id"] = fileId;
      if (detail !== undefined) output["detail"] = detail;
      return output;
    }
  }
  return { type: "computer_screenshot" };
}

export function canonicalToResponsesPayload(
  request: CanonicalRequest,
  supportsPromptCaching = true,
): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  // `pending_safety_checks` have no canonical content-part representation, so
  // `parseResponsesRequest` retains them per-item in the scoped item-metadata
  // extension. Restore them here so a computer-use turn replays losslessly.
  const itemMetadata = request.generation_controls["extension:responses.item_metadata"];
  const pendingSafetyChecks = (callId: string): unknown[] | undefined => {
    if (!Array.isArray(itemMetadata)) return undefined;
    const entry = itemMetadata.find(
      (m) => isRecord(m) && m["type"] === "computer_call" && m["call_id"] === callId,
    );
    if (!isRecord(entry)) return undefined;
    const checks = entry["pending_safety_checks"];
    return Array.isArray(checks) ? checks : undefined;
  };
  for (const [parts, role] of [
    [request.system, "system"],
    [request.instructions, "developer"],
  ] as const) {
    if (!parts?.length) continue;
    const content: Array<Record<string, unknown>> = [];
    for (const part of parts) {
      if (part.kind === "text" && !isClaudeBillingHeaderText(part.text))
        content.push({ type: "input_text", text: part.text });
    }
    if (content.length) input.push({ type: "message", role, content });
  }
  for (const m of request.messages) {
    const isAssistant = m.role === "assistant";
    const pending: Array<Record<string, unknown>> = [];
    const flushMessage = (): void => {
      if (pending.length === 0) return;
      const item: Record<string, unknown> = { type: "message", role: m.role, content: pending.splice(0) };
      if (m.phase) item.phase = m.phase;
      input.push(item);
    };
    for (const p of m.content) {
      if (p.kind === "toolCall") {
        flushMessage();
        if (p.call_kind === "computer") {
          const actions =
            isRecord(p.arguments) && Array.isArray(p.arguments["actions"])
              ? p.arguments["actions"]
              : [];
          const checks = pendingSafetyChecks(p.call_id);
          input.push({
            type: "computer_call",
            ...(p.item_id === undefined ? {} : { id: p.item_id }),
            call_id: p.call_id,
            actions,
            ...(checks === undefined ? {} : { pending_safety_checks: checks }),
            status: "completed",
          });
        } else {
          input.push({
            type: "function_call",
            ...(p.item_id === undefined ? {} : { id: p.item_id }),
            call_id: p.call_id,
            name: p.name,
            arguments:
              typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments),
          });
        }
      } else if (p.kind === "toolResult") {
        // Tool results arrive under `role: "tool"` (OpenAI Chat) OR `role: "user"`
        // (Anthropic Messages, whose tool ledger re-homes them). Both must reach
        // the provider as a `function_call_output`, never be swallowed into a
        // bare message — that is what made a Messages-session tool loop lose its
        // results when the target provider ran on the Responses wire.
        flushMessage();
        if (p.call_kind === "computer") {
          input.push({
            type: "computer_call_output",
            ...(p.item_id === undefined ? {} : { id: p.item_id }),
            call_id: p.call_id,
            output: computerOutputForWire(p.content),
            status: "completed",
          });
        } else {
          input.push({
            type: "function_call_output",
            ...(p.item_id === undefined ? {} : { id: p.item_id }),
            call_id: p.call_id,
            output: typeof p.content === "string" ? p.content : JSON.stringify(p.content),
          });
        }
      } else if (p.kind === "reasoning" && p.encrypted_content !== undefined) {
        flushMessage();
        // Replays prior encrypted reasoning so the model retains continuity
        // across turns; never decrypted or reconstructed from summary text.
        input.push({ type: "reasoning", encrypted_content: p.encrypted_content });
      } else if (p.kind === "reasoning") {
        // Plain reasoning replayed from another surface (a Messages `thinking`
        // block, or Chat `reasoning_content`). It has no encrypted artifact, so
        // it travels as a summary the model can read on the next turn instead
        // of being dropped — which is what made a cross-surface session lose
        // its chain of thought the moment it reached a Responses provider.
        const text =
          typeof p.summary === "string"
            ? p.summary
            : typeof p.payload === "string"
              ? p.payload
              : undefined;
        if (text !== undefined && text.length > 0) {
          flushMessage();
          input.push({
            type: "reasoning",
            summary: [{ type: "summary_text", text }],
          });
        }
      } else if (p.kind === "text") {
        pending.push({ type: isAssistant ? "output_text" : "input_text", text: p.text });
      } else if (p.kind === "image") {
        const source = resolveImageSource(p.payload);
        if (source?.url !== undefined) {
          pending.push({
            type: "input_image",
            image_url: source.url,
            ...(source.detail === undefined ? {} : { detail: source.detail }),
          });
        } else if (source?.fileId !== undefined) {
          pending.push({
            type: "input_image",
            file_id: source.fileId,
            ...(source.detail === undefined ? {} : { detail: source.detail }),
          });
        } else {
          pending.push({ type: "input_text", text: "[image: unsupported source]" });
        }
      } else if (p.kind === "file" || p.kind === "document") {
        const isFile = p.kind === "file";
        const sourceType = isFile ? undefined : p.source_type;
        const fileId = p.file_id;
        const filename = isFile ? p.filename : p.title;
        const url = p.url;
        if (sourceType === "text" && typeof p.data === "string") {
          // Anthropic text documents are plain text; the Responses wire carries
          // them as text rather than base64 `file_data`.
          pending.push({ type: isAssistant ? "output_text" : "input_text", text: p.data });
        } else {
          const referenceOnly =
            sourceType === "url" || sourceType === "file" || (url !== undefined && p.data === url);
          const block: Record<string, unknown> = { type: "input_file" };
          if (fileId !== undefined) block.file_id = fileId;
          else if (url !== undefined && referenceOnly) block.file_url = url;
          else if (p.data !== undefined && p.data !== null && p.data !== "")
            block.file_data = p.data;
          if (filename !== undefined) block.filename = filename;
          pending.push(block);
        }
      } else if (p.kind === "audio") {
        pending.push({ type: "input_audio", data: p.data, media_type: p.media_type });
      } else if (p.kind === "refusal") {
        pending.push({ type: isAssistant ? "output_text" : "input_text", text: p.text });
      }
      // `extension` (server_tool_use, search_result, …) has no Responses
      // representation and degrades away silently.
    }
    flushMessage();
  }
  if (
    supportsPromptCaching &&
    request.cache_hint !== undefined &&
    request.cache_hint !== "stable_prefix" &&
    request.cache_hint.list.length > 0
  ) {
    markLatestResponsesCacheBreakpoint(input);
  }
  const payload: Record<string, unknown> = {
    model: request.model,
    input,
    stream: request.stream,
  };
  const responsesCacheKey = resolvePromptCacheKey(request);
  if (supportsPromptCaching && responsesCacheKey !== undefined)
    payload.prompt_cache_key = responsesCacheKey;
  if (request.tools?.length) {
    payload["tools"] = request.tools.map((tool) => {
      if (tool.tool_type === "custom") {
        return {
          type: "custom",
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(isRecord(tool.jsonSchema) && Object.keys(tool.jsonSchema).length > 0
            ? { format: tool.jsonSchema }
            : {}),
        };
      }
      if (tool.tool_type !== undefined && tool.tool_type !== "function" && isRecord(tool.jsonSchema))
        return tool.jsonSchema;
      return {
        type: "function",
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.jsonSchema,
        ...(tool.strict === true ? { strict: true } : {}),
        ...(tool.input_examples === undefined ? {} : { input_examples: tool.input_examples }),
        ...(tool.defer_loading === undefined ? {} : { defer_loading: tool.defer_loading }),
        ...(tool.allowed_callers === undefined ? {} : { allowed_callers: tool.allowed_callers }),
      };
    });
  }
  if (request.tool_choice) {
    if (typeof request.tool_choice === "object" && request.tool_choice.type === "allowed_tools") {
      payload.tool_choice = {
        type: "allowed_tools",
        mode: request.tool_choice.mode,
        tools: request.tool_choice.names.map((name) => ({ type: "function", name })),
      };
    } else if (typeof request.tool_choice === "object" && request.tool_choice.type === "tool") {
      payload.tool_choice = { type: "function", name: request.tool_choice.name };
    } else if (typeof request.tool_choice === "object" && request.tool_choice.type === "custom") {
      payload.tool_choice = { type: "custom", name: request.tool_choice.name };
    } else {
      payload.tool_choice = request.tool_choice;
    }
  }
  if (request.conversation?.previous_response_id !== undefined)
    payload.previous_response_id = request.conversation.previous_response_id;
  if (request.conversation?.conversation_id !== undefined)
    payload.conversation = request.conversation.conversation_id;
  if (request.metadata !== undefined) payload.metadata = request.metadata;
  if (request.reasoning) {
    const reasoning: Record<string, unknown> = {};
    if (request.reasoning.effort !== undefined) {
      const effort = clampReasoningEffort(
        request.reasoning.effort,
        resolveSupportedReasoningEfforts(request.model, "responses"),
      );
      if (effort !== undefined) reasoning.effort = effort;
    }
    if (request.reasoning.mode !== undefined) reasoning.mode = request.reasoning.mode;
    if (request.reasoning.context !== undefined) reasoning.context = request.reasoning.context;
    if (request.reasoning.summary_mode !== undefined)
      reasoning.summary = request.reasoning.summary_mode;
    else if (request.reasoning.summary !== undefined) reasoning.summary = request.reasoning.summary;
    if (Object.keys(reasoning).length > 0) payload.reasoning = reasoning;
  }
  Object.assign(
    payload,
    pickWireSupportedControls(normalizeGenerationControls(request.generation_controls), "responses"),
  );
  // Responses top-level params carried as `extension:responses.<field>` and
  // forwarded verbatim. Fields with a canonical slot (prompt_cache_key,
  // previous_response_id, conversation, metadata, stream, reasoning) and
  // nested artifacts (verbosity, read under `text` below) are absent because
  // they are re-emitted from `CanonicalRequest` instead.
  const responsesPassthrough: ReadonlyArray<string> = [
    "store",
    "background",
    "truncation",
    "max_tool_calls",
    "include",
    "prompt_cache_retention",
    "stream_options",
    "top_logprobs",
    "moderation",
    "safety_identifier",
    "prompt",
    "context_management",
    "user",
  ];
  for (const field of responsesPassthrough) {
    const value = request.generation_controls[`extension:responses.${field}`];
    if (value !== undefined) payload[field] = value;
  }
  // Responses nests output verbosity and structured-output format under `text`.
  const verbosity = request.generation_controls["extension:responses.verbosity"];
  if (request.response_format !== undefined || verbosity !== undefined) {
    const text = (payload["text"] as Record<string, unknown> | undefined) ?? {};
    if (verbosity !== undefined) text["verbosity"] = verbosity;
    const format = request.response_format;
    if (format?.type === "json_object") {
      text["format"] = { type: "json_object" };
    } else if (format?.type === "json_schema") {
      text["format"] = {
        type: "json_schema",
        ...(format.name === undefined ? {} : { name: format.name }),
        ...(format.schema === undefined ? {} : { schema: format.schema }),
        ...(format.strict === undefined ? {} : { strict: format.strict }),
        ...(format.description === undefined ? {} : { description: format.description }),
      };
    }
    payload["text"] = text;
  }
  return payload;
}

