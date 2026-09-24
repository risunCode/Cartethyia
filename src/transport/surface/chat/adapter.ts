import type { CanonicalEvent, CanonicalMessage, CanonicalRequest, ContentPart } from "../../canonical-model";
import type { SurfaceAdapter, SurfaceInput, SurfaceOutput } from "../adapters";
import { isRecord } from "../../../protocol/primitives";
import { readString } from "../../../protocol/primitives";
import type { ChatEncodeOptions } from "./parse";
import {
  decodeBody,
  parseGenerationControls,
  parseMessage,
  requestBody,
} from "./parse";
import {
  parseReasoningIntent,
  parseResponseFormat,
  parseToolChoice,
  parseToolDefinition,
} from "../dialects";
import {
  asJsonBytes,
  getModel,
  getResponseId,
  jsonCompletion,
} from "./encode";

/** Pure OpenAI Chat Completions request/response surface adapter. */
export class ChatAdapter implements SurfaceAdapter {
  readonly surface = "chat" as const;

  /** Returns whether a body has the distinguishing Chat `messages[]` shape. */
  matchesBodyShape(body: unknown): boolean {
    const value = decodeBody(body);
    if (!isRecord(value) || "input" in value || !Array.isArray(value.messages)) return false;
    if (value.messages.length === 0) return false;
    if (typeof value.max_tokens === "number") {
      const hasBlockContent = value.messages.some((message) => {
        if (!isRecord(message) || !Array.isArray(message.content)) return false;
        return message.content.some((part) => isRecord(part) && "type" in part);
      });
      if (hasBlockContent) return false;
    }
    return value.messages.some((message) => isRecord(message) && typeof message.role === "string");
  }

  /** Parses a body or SurfaceInput into the provider-neutral canonical request. */
  parse(input: SurfaceInput | unknown): CanonicalRequest {
    const value = requestBody(input);
    const body = isRecord(value) ? value : {};
    const wireMessages = Array.isArray(body.messages) ? body.messages : [];
    const system: ContentPart[] = [];
    const instructions: ContentPart[] = [];
    const messages: CanonicalMessage[] = [];
    for (const wireMessage of wireMessages) {
      const message = parseMessage(wireMessage);
      if (message.role === "system") system.push(...message.content);
      else if (message.role === "developer") instructions.push(...message.content);
      else messages.push(message);
    }

    const tools = Array.isArray(body.tools)
      ? body.tools.flatMap((tool) => {
          const parsed = parseToolDefinition(tool, "chat");
          return parsed === undefined ? [] : [parsed];
        })
      : [];
    const controls = parseGenerationControls(body);
    const toolChoice = parseToolChoice(body.tool_choice, "chat");
    const responseFormat = parseResponseFormat(body.response_format);
    const model = readString(body, "model") ?? "";
    const request: CanonicalRequest = {
      model,
      messages,
      generation_controls: controls,
      stream: body.stream === true,
      source_surface: "chat",
    };
    if ((typeof body.prompt_cache_key === "string" && body.prompt_cache_key.length > 0) || body.cache_control === "auto")
      request.cache_hint = "stable_prefix";
    if (system.length > 0) request.system = system;
    if (instructions.length > 0) request.instructions = instructions;
    if (tools.length > 0) request.tools = tools;
    if (toolChoice !== undefined) request.tool_choice = toolChoice;
    if (responseFormat !== undefined) request.response_format = responseFormat;
    const reasoning = parseReasoningIntent(body);
    if (reasoning !== undefined) request.reasoning = reasoning;
    return request;
  }

  /** Encodes canonical events as one JSON completion. */
  encode(events: CanonicalEvent[], options: ChatEncodeOptions = {}): SurfaceOutput {
    const model = getModel(options, events);
    const id = getResponseId(options, events);
    const created = options.created ?? Math.floor(Date.now() / 1000);
    return {
      bytes: asJsonBytes(jsonCompletion(events, options, model, id, created)),
      content_type: "application/json",
    };
  }
}

/** Singleton adapter useful for registry composition without mutable state. */
export const chatAdapter = new ChatAdapter();
