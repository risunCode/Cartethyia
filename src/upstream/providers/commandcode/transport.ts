import type { AnthropicStopReason } from "../../../translate/concerns/finishReasons";
import type { OpenAIChatMessage, OpenAIChatRequest } from "../../../translate/types";
import type { StreamEvent } from "../../bridge";
import { ProviderCallError } from "../index";
import { flattenMessageText } from "../../../shared/text-utils";

const CLI_ENVIRONMENT = "cli";
const COMMAND_CODE_VERSION = "1.4.4";
const DEFAULT_MAX_TOKENS = 4096;

export interface CommandCodeProfileHeaders extends Record<string, string> {
  "content-type": string;
  accept: string;
  authorization: string;
  "x-command-code-version": string;
  "x-cli-environment": string;
  "x-session-id": string;
}

export interface CommandCodeRequest {
  threadId: string;
  memory: string;
  config: Record<string, unknown>;
  params: {
    model: string;
    messages: CommandCodeMessage[];
    stream: true;
    max_tokens: number;
    temperature: number;
    system?: string;
    tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
    top_p?: number;
  };
}

interface CommandCodeMessage {
  role: "user" | "assistant" | "tool";
  content: Array<Record<string, unknown>>;
}

interface ConvertedMessages {
  messages: CommandCodeMessage[];
  system?: string;
}

interface DecoderState {
  toolIndexById: Map<string, number>;
  nextToolIndex: number;
  finishReason: AnthropicStopReason | undefined;
  usage: Record<string, unknown> | undefined;
}

/** Builds the CLI-compatible headers required by Command Code's alpha transport. */
export function buildCommandCodeHeaders(sessionId: string, token: string): CommandCodeProfileHeaders {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${token}`,
    "x-command-code-version": COMMAND_CODE_VERSION,
    "x-cli-environment": CLI_ENVIRONMENT,
    "x-session-id": sessionId,
  };
}

/** Converts an OpenAI Chat request into Command Code's forced-stream request envelope. */
export function buildCommandCodeRequest(modelId: string, body: OpenAIChatRequest, threadId: string): CommandCodeRequest {
  const { messages, system } = convertMessages(body.messages);
  const params: CommandCodeRequest["params"] = {
    model: modelId,
    messages,
    stream: true,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
    temperature: body.temperature ?? 0.3,
  };

  if (system) params.system = system;

  const tools = convertTools(body.tools);
  if (tools) params.tools = tools;
  if (body.top_p != null) params.top_p = body.top_p;

  return {
    threadId,
    memory: "",
    config: {
      workingDir: "",
      date: new Date().toISOString().slice(0, 10),
      environment: "",
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    params,
  };
}

/** Decodes Command Code's NDJSON AI SDK stream into canonical proxy events. */
export async function* decodeCommandCodeNdjsonStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state = createDecoderState();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let lineEnd: number;
      while ((lineEnd = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        const event = parseLine(line);
        if (event) yield* decodeEvent(event, state);
      }
    }

    const last = buffer.trim();
    if (last) {
      const event = parseLine(last);
      if (event) yield* decodeEvent(event, state);
    }
  } finally {
    reader.releaseLock();
  }
}

function hasTypeAndText(value: unknown): value is { type: unknown; text: unknown } {
  return value !== null && typeof value === "object" && "type" in value && "text" in value;
}

function flattenText(content: unknown): string {
  return flattenMessageText(content, "\n");
}

function toContentBlocks(content: unknown): Array<{ type: "text"; text: string }> {
  if (content == null) return [{ type: "text", text: "" }];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }];

  const blocks: Array<{ type: "text"; text: string }> = [];
  for (const part of content) {
    if (typeof part === "string") {
      blocks.push({ type: "text", text: part });
    } else if (hasTypeAndText(part)) {
      if (part.type === "text" && typeof part.text === "string") {
        blocks.push({ type: "text", text: part.text });
      } else if (part.type === "image_url" || part.type === "image") {
        blocks.push({ type: "text", text: "[image omitted]" });
      } else if (typeof part.text === "string") {
        blocks.push({ type: "text", text: part.text });
      }
    }
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}

function safeParseJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // An upstream tool-call payload may contain incomplete JSON while streaming.
  }
  return {};
}

function convertMessages(messages: OpenAIChatMessage[]): ConvertedMessages {
  const output: CommandCodeMessage[] = [];
  const systemTexts: string[] = [];

  for (const message of messages) {
    if (!message) continue;

    if (message.role === "system") {
      const text = flattenText(message.content);
      if (text) systemTexts.push(text);
      continue;
    }

    if (message.role === "tool") {
      const value = typeof message.content === "string" ? message.content : flattenText(message.content);
      output.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: message.tool_call_id || "",
          toolName: message.name || "",
          output: { type: "text", value },
        }],
      });
      continue;
    }

    if (message.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      const text = flattenText(message.content);
      if (text) blocks.push({ type: "text", text });
      if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          const fn = toolCall.function || {};
          blocks.push({
            type: "tool-call",
            toolCallId: toolCall.id || "",
            toolName: fn.name || "",
            input: safeParseJson(fn.arguments),
          });
        }
      }
      output.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
      continue;
    }

    output.push({ role: "user", content: toContentBlocks(message.content) });
  }

  return {
    messages: output,
    system: systemTexts.length ? systemTexts.join("\n\n") : undefined,
  };
}

function convertTools(tools: OpenAIChatRequest["tools"]): Array<{ name: string; description?: string; input_schema: Record<string, unknown> }> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const result: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }> = [];
  for (const tool of tools) {
    if (!tool) continue;
    if (tool.type === "function" && tool.function) {
      result.push({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters || { type: "object" },
      });
    } else if ("name" in tool && typeof tool.name === "string" && ("input_schema" in tool || "parameters" in tool)) {
      const schema = "input_schema" in tool ? tool.input_schema : tool.parameters;
      if (schema !== null && typeof schema === "object" && !Array.isArray(schema)) {
        result.push({
          name: tool.name,
          description: "description" in tool && typeof tool.description === "string" ? tool.description : undefined,
          input_schema: schema as Record<string, unknown>,
        });
      }
    }
  }
  return result.length ? result : undefined;
}

function createDecoderState(): DecoderState {
  return {
    toolIndexById: new Map<string, number>(),
    nextToolIndex: 0,
    finishReason: undefined,
    usage: undefined,
  };
}

function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const json = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!json || json === "[DONE]") return undefined;
  return safeParseJson(json);
}

function eventString(event: Record<string, unknown>, key: string): string {
  const value = event[key];
  return typeof value === "string" ? value : "";
}

function eventNumber(event: Record<string, unknown>, key: string): number | undefined {
  const value = event[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mapFinishReason(reason: string): AnthropicStopReason {
  const reasons: Record<string, AnthropicStopReason> = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "refusal",
  };
  return reasons[reason] ?? "end_turn";
}

function emitToolCallStart(state: DecoderState, id: string, name: string): StreamEvent[] {
  if (state.toolIndexById.has(id)) return [];
  state.toolIndexById.set(id, state.nextToolIndex++);
  return [{ type: "tool_call_start", id, name }];
}

function emitToolCallArgsDelta(state: DecoderState, id: string, delta: string): StreamEvent[] {
  if (!state.toolIndexById.has(id) || !delta) return [];
  return [{ type: "tool_call_args_delta", id, argumentsDelta: delta }];
}

function decodeEvent(event: Record<string, unknown>, state: DecoderState): StreamEvent[] {
  const type = eventString(event, "type");
  if (!type) return [];

  if (type === "text-delta" || type === "reasoning-delta") {
    const text = eventString(event, "text") || eventString(event, "delta");
    return text ? [{ type: "text_delta", text }] : [];
  }

  if (type === "tool-input-start") {
    const id = eventString(event, "id") || eventString(event, "toolCallId");
    return id ? emitToolCallStart(state, id, eventString(event, "toolName")) : [];
  }

  if (type === "tool-input-delta") {
    const id = eventString(event, "id") || eventString(event, "toolCallId");
    const delta = eventString(event, "delta") || eventString(event, "inputTextDelta");
    return id ? emitToolCallArgsDelta(state, id, delta) : [];
  }

  if (type === "tool-call") {
    const id = eventString(event, "toolCallId");
    if (!id || state.toolIndexById.has(id)) return [];
    const input = typeof event.input === "string" ? safeParseJson(event.input) : event.input;
    const inputObject = input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    return [
      ...emitToolCallStart(state, id, eventString(event, "toolName")),
      { type: "tool_call_args_delta", id, argumentsDelta: JSON.stringify(inputObject) },
    ];
  }

  if (type === "finish-step") {
    const reason = eventString(event, "finishReason");
    if (reason) state.finishReason = mapFinishReason(reason);
    const usage = event.usage;
    if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) state.usage = usage as Record<string, unknown>;
    return [];
  }

  if (type === "finish") {
    const events: StreamEvent[] = [{ type: "finish", stopReason: state.finishReason ?? mapFinishReason(eventString(event, "finishReason") || "stop") }];
    if (state.usage) {
      events.push({
        type: "usage",
        inputTokens: eventNumber(state.usage, "promptTokens") ?? eventNumber(state.usage, "inputTokens") ?? 0,
        outputTokens: eventNumber(state.usage, "completionTokens") ?? eventNumber(state.usage, "outputTokens") ?? 0,
        reasoningTokens: 0,
        cacheReadTokens: eventNumber(state.usage, "cacheReadTokens") ?? 0,
        cacheWriteTokens: eventNumber(state.usage, "cacheWriteTokens") ?? 0,
      });
    }
    return events;
  }

  if (type === "error") {
    const value = event.error ?? event.message ?? "unknown";
    const message = typeof value === "string" ? value : JSON.stringify(value);
    throw new ProviderCallError(502, "malformed_response", `Command Code stream reported an error: ${message}`);
  }

  return [];
}
