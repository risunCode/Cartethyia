import type { CanonicalMessage, CanonicalRequest, ContentPart, GenerationControls, ToolDefinition } from "../../canonical-model";
import { isRecord } from "../../../protocol/primitives";
import { textPart } from "../content-parts";
import {
  isServiceTier,
  parseReasoningIntent,
  parseResponseFormat,
  parseToolChoice,
  parseToolDefinition,
} from "../dialects";
import { resolveImageSource, readBoolean, readNumber, readString } from "../../../protocol/primitives";
import { ResponsesReasoningError } from "./errors";
import type { ResponsesComputerAction, ResponsesInputItem, ResponsesItemMetadata } from "./contracts";
const OPENAI_RESPONSE_INCLUDES = {
  "file_search_call.results": true,
  "web_search_call.results": true,
  "web_search_call.action.sources": true,
  "message.input_image.image_url": true,
  "computer_call_output.output.image_url": true,
  "code_interpreter_call.outputs": true,
  "reasoning.encrypted_content": true,
  "message.output_text.logprobs": true,
} as const satisfies Record<string, true>;


/** Computer-use action types accepted on a `computer_call` item. */
const COMPUTER_ACTION_TYPES: ReadonlySet<string> = new Set([
  "click",
  "double_click",
  "drag",
  "keypress",
  "move",
  "screenshot",
  "scroll",
  "type",
  "wait",
]);


function isResponsesInclude(value: unknown): value is keyof typeof OPENAI_RESPONSE_INCLUDES {
  return typeof value === "string" && value in OPENAI_RESPONSE_INCLUDES;
}

const UNSUPPORTED_EXPLICIT_PROMPT_CACHE_MESSAGE =
  "responses: prompt_cache_options and prompt_cache_breakpoint are unsupported; use prompt_cache_key instead";

function hasUnsupportedExplicitPromptCacheFields(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (hasOwn(body, "prompt_cache_options") || hasOwn(body, "prompt_cache_breakpoint")) return true;
  if (!Array.isArray(body["input"])) return false;
  return body["input"].some((item) => {
    if (!isRecord(item)) return false;
    if (hasOwn(item, "prompt_cache_breakpoint")) return true;
    return (
      Array.isArray(item["content"]) &&
      item["content"].some((part) => isRecord(part) && hasOwn(part, "prompt_cache_breakpoint"))
    );
  });
}

function rejectUnsupportedExplicitPromptCacheFields(body: unknown): void {
  if (hasUnsupportedExplicitPromptCacheFields(body))
    throw new Error(UNSUPPORTED_EXPLICIT_PROMPT_CACHE_MESSAGE);
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function parseJsonBody(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(value)) as unknown;
  }
  if (typeof value === "string") return JSON.parse(value) as unknown;
  return value;
}

export function unwrapBody(input: unknown): unknown {
  if (
    isRecord(input) &&
    hasOwn(input, "body") &&
    (hasOwn(input, "headers") || hasOwn(input, "path"))
  ) {
    return parseJsonBody(input.body);
  }
  return parseJsonBody(input);
}

/**
 * The readable text of a `reasoning` item, from either place a provider puts it.
 *
 * The Responses API states reasoning under `summary` (a list of
 * `{type:"summary_text", text}`), and that is what a well-formed item carries.
 * A reasoning item may instead carry `content` with `{type:"reasoning_text",
 * text}` — the shape emitted when the reasoning is replayed rather than
 * summarized — and reading only `summary` made such an item parse to no text at
 * all. That is worse than dropping it: the Chat encoder then emitted
 * `reasoning_content: ""`, which the provider reads as "thinking mode with the
 * reasoning stripped" and rejects with the very error this is here to prevent
 * ("the reasoning content from the previous turn must be passed back in thinking
 * mode"). Both fields are read, in that order, because a provider that states
 * both means the summary as the readable form.
 */
function responseReasoningSummary(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const summaries = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const text = entry["text"];
    return typeof text === "string" ? [text] : [];
  });
  return summaries.length > 0 ? summaries.join("\n\n") : undefined;
}

/** The `reasoning_text` bodies of a reasoning item's `content` blocks. */
function responseReasoningContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const texts = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    // `reasoning_text` is the documented block type; a bare `text` block is
    // accepted because providers in the wild emit it for the same field.
    const type = entry["type"];
    if (type !== "reasoning_text" && type !== "text") return [];
    const text = entry["text"];
    return typeof text === "string" ? [text] : [];
  });
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

/** The readable text of one reasoning item, preferring its summary. */
function reasoningItemText(item: ResponsesInputItem): string | undefined {
  return responseReasoningSummary(item["summary"]) ?? responseReasoningContent(item["content"]);
}

function parseInputContent(value: unknown): { parts: ContentPart[]; contentTypes: string[] } {
  if (typeof value === "string") return { parts: [textPart(value)], contentTypes: ["input_text"] };
  if (!Array.isArray(value)) return { parts: [], contentTypes: [] };

  const parts: ContentPart[] = [];
  const contentTypes: string[] = [];
  for (const rawPart of value) {
    if (!isRecord(rawPart)) throw new Error("Responses message content blocks must be objects");
    const type = readString(rawPart, "type");
    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = readString(rawPart, "text");
      if (text === undefined) throw new Error("Responses text content blocks require text");
      parts.push(textPart(text));
      contentTypes.push(type);
      continue;
    }
    if (type === "input_image" || type === "output_image" || type === "image") {
      parts.push({ kind: "image", payload: rawPart });
      contentTypes.push(type);
      continue;
    }
    if (type === "input_file" || type === "output_file" || type === "file") {
      const filename = readString(rawPart, "filename");
      const fileId = readString(rawPart, "file_id");
      const url = readString(rawPart, "file_url") ?? readString(rawPart, "url");
      parts.push({
        kind: "file",
        data: rawPart["file_data"] ?? url ?? "",
        media_type:
          readString(rawPart, "mime_type") ??
          readString(rawPart, "media_type") ??
          "application/octet-stream",
        ...(filename === undefined ? {} : { filename }),
        ...(fileId === undefined ? {} : { file_id: fileId }),
        ...(url === undefined ? {} : { url }),
      });
      contentTypes.push(type);
      continue;
    }
    if (type === "document") {
      const source = isRecord(rawPart.source) ? rawPart.source : rawPart;
      const sourceType = isRecord(source) ? readString(source, "type") : undefined;
      const fileId = isRecord(source) ? readString(source, "file_id") : undefined;
      const url = isRecord(source) ? readString(source, "url") : undefined;
      parts.push({
        kind: "document",
        data: (isRecord(source) ? (source.data ?? fileId ?? url ?? "") : "") as string,
        media_type: (isRecord(source) && typeof source.media_type === "string" ? source.media_type : typeof rawPart.mime_type === "string" ? rawPart.mime_type : "application/octet-stream") as string,
        ...(typeof rawPart.title === "string" ? { title: rawPart.title } : {}),
        ...(sourceType === "base64" ||
        sourceType === "url" ||
        sourceType === "file" ||
        sourceType === "text"
          ? { source_type: sourceType }
          : {}),
        ...(url === undefined ? {} : { url }),
        ...(fileId === undefined ? {} : { file_id: fileId }),
      });
      contentTypes.push(type);
      continue;
    }
    if (type === "input_audio" || type === "output_audio" || type === "audio") {
      parts.push({
        kind: "audio",
        data: rawPart["data"] ?? rawPart["audio"] ?? "",
        media_type: readString(rawPart, "media_type") ?? "audio/mpeg",
      });
      contentTypes.push(type);
      continue;
    }
    if (type === "refusal") {
      parts.push({ kind: "refusal", text: readString(rawPart, "refusal") ?? "" });
      contentTypes.push(type);
      continue;
    }
    // A reasoning block replayed from the Messages wire (`thinking`) or nested
    // inside a message instead of its own `reasoning` item. Keep the chain of
    // thought; dropping it as an extension loses it on the next turn.
    if (type === "thinking" || type === "reasoning") {
      const text =
        readString(rawPart, "thinking") ?? readString(rawPart, "text") ?? readString(rawPart, "summary");
      parts.push({
        kind: "reasoning",
        payload: text ?? null,
        ...(text === undefined ? {} : { summary: text }),
      });
      contentTypes.push(type);
      continue;
    }
    if (type === "redacted_thinking") {
      parts.push({ kind: "reasoning", payload: rawPart, opaque: true });
      contentTypes.push(type);
      continue;
    }
    parts.push({
      kind: "extension",
      name: `responses.content.${type ?? "unknown"}`,
      payload: rawPart,
    });
    contentTypes.push(type ?? "unknown");
  }
  return { parts, contentTypes };
}

function itemMetadata(
  item: Record<string, unknown>,
  contentTypes?: readonly string[],
): ResponsesItemMetadata {
  const metadata: ResponsesItemMetadata = {
    type: readString(item, "type") ?? "message",
  };
  const id = readString(item, "id");
  const callId = readString(item, "call_id");
  const role = readString(item, "role");
  const phase = readString(item, "phase");
  if (id !== undefined) metadata.id = id;
  if (callId !== undefined) metadata.call_id = callId;
  if (role !== undefined) metadata.role = role;
  if (contentTypes !== undefined) metadata.content_types = contentTypes.slice();
  if (phase === "commentary" || phase === "final_answer") metadata.phase = phase;
  if (Array.isArray(item["pending_safety_checks"]))
    metadata.pending_safety_checks = item["pending_safety_checks"];
  return metadata;
}


function parseResponsesComputerAction(action: unknown, index: number): ResponsesComputerAction {
  if (!isRecord(action)) throw new Error(`Responses computer action ${index} must be an object`);
  const actionType = readString(action, "type");
  if (actionType === undefined || !COMPUTER_ACTION_TYPES.has(actionType))
    throw new Error(
      `Responses computer action ${index} has unsupported type: ${actionType ?? "missing"}`,
    );
  return action as unknown as ResponsesComputerAction;
}

function parseResponsesComputerActions(item: Record<string, unknown>): ResponsesComputerAction[] {
  const raw = item["actions"] ?? (item["action"] === undefined ? [] : [item["action"]]);
  if (!Array.isArray(raw)) throw new Error("Responses computer_call actions must be an array");
  return raw.map(parseResponsesComputerAction);
}

function parseComputerCallOutput(output: unknown): ContentPart[] | string {
  if (typeof output === "string") return output;
  if (isRecord(output)) {
    const imageUrl = output["image_url"] ?? output["url"];
    const detail = readString(output, "detail");
    if (imageUrl !== undefined) {
      const payload: Record<string, unknown> = { type: "output_image", image_url: imageUrl };
      if (detail !== undefined) payload["detail"] = detail;
      return [{ kind: "image", payload }];
    }
    const fileId = readString(output, "file_id");
    if (fileId !== undefined)
      return [{ kind: "image", payload: { type: "output_image", file_id: fileId } }];
  }
  return output === undefined ? "" : JSON.stringify(output);
}

export function computerOutputToWire(content: readonly ContentPart[] | string): Record<string, unknown> {
  if (typeof content === "string") return { type: "computer_screenshot", image_url: content };
  const image = content.find((part) => part.kind === "image");
  if (image !== undefined && image.kind === "image" && isRecord(image.payload)) {
    const output: Record<string, unknown> = { type: "computer_screenshot" };
    const imageUrl = image.payload["image_url"] ?? image.payload["url"];
    const fileId = image.payload["file_id"];
    const detail = image.payload["detail"];
    if (imageUrl !== undefined) output["image_url"] = imageUrl;
    if (fileId !== undefined) output["file_id"] = fileId;
    if (detail !== undefined) output["detail"] = detail;
    return output;
  }
  return { type: "computer_screenshot", image_url: outputToWire(content) };
}

export function parseResponsesComputerActionChunks(chunks: string): ResponsesComputerAction[] {
  const text = chunks.trim();
  if (text.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  if (isRecord(parsed) && Array.isArray(parsed["actions"]))
    return parsed["actions"] as ResponsesComputerAction[];
  if (Array.isArray(parsed)) return parsed as ResponsesComputerAction[];
  if (isRecord(parsed)) return [parsed as unknown as ResponsesComputerAction];
  return [];
}

function parseInputItem(item: ResponsesInputItem): {
  message: CanonicalMessage;
  metadata: ResponsesItemMetadata;
} {
  const type = readString(item, "type") ?? "message";
  if (type === "message") {
    const role = readString(item, "role") ?? "user";
    if (
      role !== "system" &&
      role !== "developer" &&
      role !== "user" &&
      role !== "assistant" &&
      role !== "tool"
    ) {
      throw new Error(`Unsupported Responses message role: ${role}`);
    }
    const parsed = parseInputContent(item["content"]);
    const metadata = itemMetadata(item, parsed.contentTypes);
    const message: CanonicalMessage = { role, content: parsed.parts };
    if (role === "assistant" && metadata.phase !== undefined) message.phase = metadata.phase;
    return { message, metadata };
  }
  if (type === "function_call") {
    const id = readString(item, "id");
    const callId = readString(item, "call_id") ?? id;
    const name = readString(item, "name");
    if (callId === undefined || name === undefined)
      throw new Error("Responses function_call requires call_id and name");
    const args = item["arguments"];
    if (args === undefined) throw new Error("Responses function_call requires arguments");
    return {
      message: {
        role: "assistant",
        content: [
          {
            kind: "toolCall",
            call_id: callId,
            name,
            arguments: args,
            ...(id === undefined ? {} : { item_id: id }),
          },
        ],
      },
      metadata: itemMetadata(item),
    };
  }
  if (type === "function_call_output") {
    const callId = readString(item, "call_id");
    if (callId === undefined) throw new Error("Responses function_call_output requires call_id");
    const id = readString(item, "id");
    const itemId = id === undefined ? {} : { item_id: id };
    const output = item["output"];
    if (typeof output === "string") {
      return {
        message: {
          role: "tool",
          content: [{ kind: "toolResult", call_id: callId, content: output, ...itemId }],
        },
        metadata: itemMetadata(item),
      };
    }
    if (Array.isArray(output)) {
      const parsed = parseInputContent(output);
      return {
        message: {
          role: "tool",
          content: [{ kind: "toolResult", call_id: callId, content: parsed.parts, ...itemId }],
        },
        metadata: itemMetadata(item, parsed.contentTypes),
      };
    }
    const serialized = output === undefined ? "" : JSON.stringify(output);
    return {
      message: {
        role: "tool",
        content: [{ kind: "toolResult", call_id: callId, content: serialized, ...itemId }],
      },
      metadata: itemMetadata(item),
    };
  }
  if (type === "computer_call") {
    const id = readString(item, "id");
    const callId = readString(item, "call_id") ?? id;
    if (callId === undefined) throw new Error("Responses computer_call requires call_id");
    const actions = parseResponsesComputerActions(item);
    return {
      message: {
        role: "assistant",
        content: [
          {
            kind: "toolCall",
            call_id: callId,
            name: "computer",
            arguments: { actions },
            call_kind: "computer",
            ...(id === undefined ? {} : { item_id: id }),
          },
        ],
      },
      metadata: itemMetadata(item),
    };
  }
  if (type === "computer_call_output") {
    const id = readString(item, "id");
    const callId = readString(item, "call_id");
    if (callId === undefined) throw new Error("Responses computer_call_output requires call_id");
    return {
      message: {
        role: "tool",
        content: [
          {
            kind: "toolResult",
            call_id: callId,
            content: parseComputerCallOutput(item["output"]),
            call_kind: "computer",
            ...(id === undefined ? {} : { item_id: id }),
          },
        ],
      },
      metadata: itemMetadata(item),
    };
  }
  if (type === "reasoning") {
    const encryptedPresent = hasOwn(item, "encrypted_content");
    const encrypted = item["encrypted_content"];
    const summary = reasoningItemText(item);
    if (encryptedPresent) {
      if (typeof encrypted !== "string")
        throw new ResponsesReasoningError(
          "reasoning.encrypted_content",
          "Encrypted reasoning must remain a string artifact",
        );
      const reasoningPart: ContentPart = {
        kind: "reasoning",
        payload: encrypted,
        opaque: true,
        encrypted_content: encrypted,
      };
      if (summary !== undefined) reasoningPart.summary = summary;
      return {
        message: { role: "assistant", content: [reasoningPart] },
        metadata: itemMetadata(item),
      };
    }
    const reasoningPart: ContentPart = { kind: "reasoning", payload: summary ?? null };
    if (summary !== undefined) reasoningPart.summary = summary;
    return {
      message: { role: "assistant", content: [reasoningPart] },
      metadata: itemMetadata(item),
    };
  }
  throw new Error(`Unsupported Responses input item type: ${type}`);
}

function assignExtension(controls: GenerationControls, key: string, value: unknown): void {
  if (value !== undefined) controls[key as `extension:${string}`] = value;
}

/** Parse an OpenAI Responses body into the provider-neutral canonical request. */
export function parseResponsesRequest(input: unknown): CanonicalRequest {
  const bodyValue = unwrapBody(input);
  if (!isRecord(bodyValue)) throw new Error("Responses request body must be an object");
  rejectUnsupportedExplicitPromptCacheFields(bodyValue);
  const model = readString(bodyValue, "model");
  if (model === undefined) throw new Error("Responses request requires model");

  const rawInput = bodyValue["input"];
  const inputItems: ResponsesInputItem[] = [];
  if (typeof rawInput === "string")
    inputItems.push({ type: "message", role: "user", content: rawInput });
  else if (Array.isArray(rawInput)) {
    for (const item of rawInput) {
      if (!isRecord(item)) throw new Error("Responses input items must be objects");
      inputItems.push(item);
    }
  } else if (rawInput !== undefined) {
    throw new Error("Responses input must be a string or item array");
  }

  const parsedItems = inputItems.map(parseInputItem);
  // Anthropic-style top-level hoisting: system and developer turns become
  // canonical `system`/`instructions` so no downstream wire ever receives a
  // `developer` role (Anthropic has none) or a mid-array system turn.
  const hoistedSystemParts: ContentPart[] = [];
  const hoistedInstructionParts: ContentPart[] = [];
  const messages: CanonicalMessage[] = [];
  for (const entry of parsedItems) {
    if (entry.message.role === "system") hoistedSystemParts.push(...entry.message.content);
    else if (entry.message.role === "developer") hoistedInstructionParts.push(...entry.message.content);
    else messages.push(entry.message);
  }
  // A `reasoning` item is its own entry in `input`, and providers emit it on
  // either side of the assistant item it produced: `reasoning, function_call`
  // and `function_call, reasoning` both occur in the same conversation (the
  // captured WorkBuddy history has both). Decoding one item at a time therefore
  // split a single provider turn into two canonical messages — a reasoning-only
  // assistant turn plus the `function_call` turn — and every consumer that
  // carries reasoning as a field on the assistant turn (the Chat encoder's
  // `reasoning_content`) attached it to the wrong message, leaving the tool-call
  // turn without it. The provider then rejects the request with "the reasoning
  // content from the previous turn must be passed back in thinking mode".
  //
  // The two items are one turn, so they are folded into one message. A trailing
  // reasoning attaches to the assistant turn it follows; a leading one is held
  // and attached to the assistant turn it precedes. Reasoning is placed first in
  // the merged content either way, which is the order the provider emitted it in
  // and the order it expects back.
  const messagesWithReasoning: CanonicalMessage[] = [];
  let pendingReasoning: ContentPart[] | undefined;
  const isReasoningOnly = (message: CanonicalMessage): boolean =>
    message.role === "assistant" &&
    message.content.length > 0 &&
    message.content.every((part) => part.kind === "reasoning");
  // A type predicate, not a plain boolean: it narrows `previous` to a defined
  // message so the merge below reads its `content` without a second check.
  const isToolCallTurn = (message: CanonicalMessage | undefined): message is CanonicalMessage =>
    message !== undefined &&
    message.role === "assistant" &&
    message.content.some((part) => part.kind === "toolCall");
  for (const message of messages) {
    if (isReasoningOnly(message)) {
      const previous = messagesWithReasoning[messagesWithReasoning.length - 1];
      // A reasoning item that *follows* the assistant turn it belongs to — the
      // `function_call, reasoning` order — attaches back to that turn.
      if (isToolCallTurn(previous)) {
        messagesWithReasoning[messagesWithReasoning.length - 1] = {
          ...previous,
          content: [...message.content, ...previous.content],
        };
        continue;
      }
      // Otherwise it *precedes* its turn; hold it for the assistant turn next.
      pendingReasoning = [...(pendingReasoning ?? []), ...message.content];
      continue;
    }
    if (pendingReasoning !== undefined) {
      if (message.role === "assistant") {
        messagesWithReasoning.push({
          ...message,
          content: [...pendingReasoning, ...message.content],
        });
        pendingReasoning = undefined;
        continue;
      }
      // Not adjacent to an assistant turn, so it is kept as its own turn
      // rather than dropped.
      messagesWithReasoning.push({ role: "assistant", content: pendingReasoning });
      pendingReasoning = undefined;
    }
    messagesWithReasoning.push(message);
  }
  if (pendingReasoning !== undefined)
    messagesWithReasoning.push({ role: "assistant", content: pendingReasoning });
  const metadata = parsedItems.map((entry) => entry.metadata);
  const controls: GenerationControls = {};
  const maxOutputTokens = readNumber(bodyValue, "max_output_tokens");
  if (maxOutputTokens !== undefined) {
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)
      throw new Error("max_output_tokens must be a positive integer");
    controls.max_output_tokens = maxOutputTokens;
  }
  const parallel = readBoolean(bodyValue, "parallel_tool_calls");
  if (parallel !== undefined) controls.parallel_tool_calls = parallel;
  const serviceTier = readString(bodyValue, "service_tier");
  if (serviceTier !== undefined && isServiceTier(serviceTier)) controls.service_tier = serviceTier;
  // The Responses API accepts `temperature`/`top_p` as top-level generation
  // parameters; the wire-support matrix already lists them for `responses`.
  const temperature = readNumber(bodyValue, "temperature");
  if (temperature !== undefined) controls.temperature = temperature;
  const topP = readNumber(bodyValue, "top_p");
  if (topP !== undefined) controls.top_p = topP;

  // Fields the encoder reads back explicitly. `previous_response_id`,
  // `conversation`, `metadata` and `stream` are absent because they have
  // canonical slots on `CanonicalRequest` and are re-emitted from there.
  const extensionFields = [
    "max_tool_calls",
    "truncation",
    "store",
    "prompt_cache_key",
    "prompt_cache_retention",
    "background",
    "user",
    "stream_options",
    "top_logprobs",
    "moderation",
    "safety_identifier",
    "prompt",
    "context_management",
  ];
  for (const field of extensionFields) {
    if (hasOwn(bodyValue, field))
      assignExtension(controls, `extension:responses.${field}`, bodyValue[field]);
  }
  // `include` is validated: only the documented OpenAI values survive so an
  // unvalidated field never reaches an upstream provider.
  const rawInclude = bodyValue["include"];
  if (rawInclude !== undefined) {
    if (!Array.isArray(rawInclude)) throw new Error("Responses include must be an array");
    assignExtension(controls, "extension:responses.include", rawInclude.filter(isResponsesInclude));
  }
  assignExtension(controls, "extension:responses.item_metadata", metadata);
  if (typeof bodyValue["omit_encrypted_reasoning"] === "boolean")
    assignExtension(controls, "extension:omit_encrypted_reasoning", bodyValue["omit_encrypted_reasoning"]);
  const text = bodyValue["text"];
  if (isRecord(text) && hasOwn(text, "verbosity"))
    assignExtension(controls, "extension:responses.verbosity", text["verbosity"]);
  const tools = Array.isArray(bodyValue["tools"])
    ? bodyValue["tools"]
        .map((tool) => parseToolDefinition(tool, "responses"))
        .filter((tool): tool is ToolDefinition => tool !== undefined)
    : undefined;

  const request: CanonicalRequest = {
    model,
    messages: messagesWithReasoning,
    generation_controls: controls,
    stream: readBoolean(bodyValue, "stream") ?? false,
    source_surface: "responses",
  };
  if (hoistedSystemParts.length > 0) request.system = hoistedSystemParts;
  const instructions = readString(bodyValue, "instructions");
  const instructionParts: ContentPart[] = [
    ...(instructions === undefined ? [] : [textPart(instructions)]),
    ...hoistedInstructionParts,
  ];
  if (instructionParts.length > 0) request.instructions = instructionParts;
  const previousResponseId = readString(bodyValue, "previous_response_id");
  const conversationId = readString(bodyValue, "conversation");
  if (previousResponseId !== undefined || conversationId !== undefined) {
    request.conversation = {
      ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId }),
      ...(conversationId === undefined ? {} : { conversation_id: conversationId }),
    };
  }
  if (isRecord(bodyValue["metadata"])) {
    const metadata: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(bodyValue["metadata"])) {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        metadata[key] = value;
    }
    request.metadata = metadata;
  }
  if (tools !== undefined) request.tools = tools;
  const toolChoice = parseToolChoice(bodyValue["tool_choice"], "responses");
  if (toolChoice !== undefined) request.tool_choice = toolChoice;
  const reasoning =
    parseReasoningIntent(
      isRecord(bodyValue["reasoning"]) ? { reasoning: bodyValue["reasoning"] } : {},
    ) ??
    parseReasoningIntent({
      reasoning: { effort: bodyValue["reasoning_effort"] ?? bodyValue["reasoning_level"] },
    });
  if (reasoning !== undefined) request.reasoning = reasoning;
  const textFormat = isRecord(bodyValue["text"]) ? bodyValue["text"]["format"] : undefined;
  const responseFormat = parseResponseFormat(textFormat);
  if (responseFormat !== undefined) request.response_format = responseFormat;
  const cacheKey = readString(bodyValue, "prompt_cache_key");
  if (cacheKey !== undefined && cacheKey.length > 0) request.cache_hint = "stable_prefix";
  return request;
}

function partToResponsesContent(part: ContentPart, contentType?: string): Record<string, unknown> | undefined {
  if (part.kind === "text") {
    const type = contentType === "output_text" ? "output_text" : "input_text";
    return { type, text: part.text };
  }
  if (part.kind === "image") {
    const source = resolveImageSource(part.payload);
    if (source?.url !== undefined) {
      return {
        type: "input_image",
        image_url: source.url,
        ...(source.detail === undefined ? {} : { detail: source.detail }),
      };
    }
    if (source?.fileId !== undefined) {
      return {
        type: "input_image",
        file_id: source.fileId,
        ...(source.detail === undefined ? {} : { detail: source.detail }),
      };
    }
    // Unrecognized source: preserve the origin payload rather than dropping bytes.
    return part.payload as Record<string, unknown>;
  }
  if (part.kind === "file") {
    const block: Record<string, unknown> = { type: "input_file" };
    if (part.file_id !== undefined) block.file_id = part.file_id;
    else if (
      part.url !== undefined &&
      (part.data === undefined || part.data === null || part.data === "" || part.data === part.url)
    )
      block.file_url = part.url;
    else if (part.data !== undefined) block.file_data = part.data;
    if (part.media_type !== undefined) block.mime_type = part.media_type;
    if (part.filename !== undefined) block.filename = part.filename;
    return block;
  }
  if (part.kind === "audio") {
    return { type: "input_audio", data: part.data, media_type: part.media_type };
  }
  if (part.kind === "document") {
    if (part.source_type === "text" && typeof part.data === "string")
      return { type: "input_text", text: part.data };
    const block: Record<string, unknown> = { type: "input_file", mime_type: part.media_type };
    if (part.file_id !== undefined) block.file_id = part.file_id;
    else if (
      part.url !== undefined &&
      (part.data === undefined || part.data === null || part.data === "" || part.data === part.url)
    )
      block.file_url = part.url;
    else if (part.data !== undefined) block.file_data = part.data;
    if (part.title !== undefined) block.filename = part.title;
    return block;
  }
  // reasoning / refusal / extension carry no message-input block;
  // reasoning is emitted as its own item upstream and the rest degrade away.
  return undefined;
}

export function outputToWire(content: readonly ContentPart[] | string): unknown {
  if (typeof content === "string") return content;
  return content
    .map((part) => partToResponsesContent(part))
    .filter((block): block is Record<string, unknown> => block !== undefined);
}
