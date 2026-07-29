/**
 * Tool schema + call-id correlation.
 *
 * Three surfaces disagree on shape:
 *  - Anthropic:              tools[].{name, description, input_schema}
 *                             tool_use content block: {id, name, input: object}
 *                             tool_result content block: {tool_use_id, content}
 *  - OpenAI Chat Completions: tools[].{type:"function", function:{name, description, parameters}}
 *                             message.tool_calls[].{id, type:"function", function:{name, arguments: STRING}}
 *                             role:"tool" message: {tool_call_id, content}
 *  - OpenAI Responses:        tools[].{type:"function", name, description, parameters} (flat, no nesting)
 *                             output item: {type:"function_call", call_id, name, arguments: STRING}
 *                             input item:  {type:"function_call_output", call_id, output}
 *
 * `arguments` is a JSON STRING on every OpenAI surface and a native OBJECT on
 * Anthropic — that mismatch is the #1 source of "tool call did nothing" bugs
 * if a translator forgets to (de)serialize it. Centralized here so every
 * translator calls the same two functions instead of re-deriving this.
 */

import type { AnthropicToolChoice, OpenAIChatToolChoice, OpenAIResponsesToolChoice } from "../types";
import { isToolCallBlock, isToolResultBlock } from "./blocks";
import type { UnifiedBlock, UnifiedMessage } from "./blocks";

export interface UnifiedToolDef {
  name: string;
  description: string | undefined;
  /** JSON Schema object, shape-agnostic (Anthropic input_schema === OpenAI parameters). */
  schema: Record<string, unknown>;
}

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface OpenAIChatToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAIResponsesToolDef {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export function anthropicToolToUnified(t: AnthropicToolDef): UnifiedToolDef {
  return { name: t.name, description: t.description, schema: t.input_schema };
}

export function unifiedToolToAnthropic(t: UnifiedToolDef): AnthropicToolDef {
  const def: AnthropicToolDef = { name: t.name, input_schema: t.schema };
  if (t.description !== undefined) def.description = t.description;
  return def;
}

export function openAIChatToolToUnified(t: OpenAIChatToolDef): UnifiedToolDef {
  return { name: t.function.name, description: t.function.description, schema: t.function.parameters };
}

export function unifiedToolToOpenAIChat(t: UnifiedToolDef): OpenAIChatToolDef {
  const fn: OpenAIChatToolDef["function"] = { name: t.name, parameters: t.schema };
  if (t.description !== undefined) fn.description = t.description;
  return { type: "function", function: fn };
}

export function openAIResponsesToolToUnified(t: OpenAIResponsesToolDef): UnifiedToolDef {
  return { name: t.name, description: t.description, schema: t.parameters };
}

export function unifiedToolToOpenAIResponses(t: UnifiedToolDef): OpenAIResponsesToolDef {
  const def: OpenAIResponsesToolDef = { type: "function", name: t.name, parameters: t.schema };
  if (t.description !== undefined) def.description = t.description;
  return def;
}

/**
 * OpenAI `arguments` is a JSON string; a model can legally emit a malformed
 * one mid-stream or on error. We never throw here — an unparsable payload
 * becomes `{}` so downstream code has a stable object to work with, and the
 * raw string is preserved by the caller for logging if needed.
 */
export function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  if (argumentsJson.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function stringifyToolArguments(input: Record<string, unknown>): string {
  return JSON.stringify(input);
}

/**
 * `tool_choice` — controls whether/which tool the model must call. Anthropic
 * and OpenAI (Chat + Responses) use different vocabularies for the same 4
 * intents (auto / none / must-call-some / must-call-this-one); dropped
 * entirely before this, so `tool_choice:"none"` silently became "auto" —
 * the model would call tools the client explicitly told it not to.
 */
export function openAIToolChoiceToAnthropic(choice: OpenAIChatToolChoice | undefined): AnthropicToolChoice | undefined {
  if (choice === undefined || choice === "auto") return undefined; // Anthropic's own default is already "auto"
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.function.name };
}

export function anthropicToolChoiceToOpenAIChat(choice: AnthropicToolChoice | undefined): OpenAIChatToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (choice.type === "tool") return { type: "function", function: { name: choice.name } };
  if (choice.type === "none") return "none";
  if (choice.type === "any") return "required";
  return undefined; // "auto"
}

export function openAIChatToolChoiceToResponses(choice: OpenAIChatToolChoice | undefined): OpenAIResponsesToolChoice | undefined {
  if (choice === undefined || typeof choice === "string") return choice;
  return { type: "function", name: choice.function.name };
}

export function responsesToolChoiceToOpenAIChat(choice: OpenAIResponsesToolChoice | undefined): OpenAIChatToolChoice | undefined {
  if (choice === undefined || typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

// ── Tool integrity (Anthropic request-shape requirements) ────────────────

const ANTHROPIC_TOOL_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Inserts an empty `tool_result` for any `tool_call` left unanswered by the
 * next message, so the request passes Anthropic's "every tool_use needs a
 * tool_result" validation instead of getting rejected outright.
 */
export function fixMissingToolResults(messages: UnifiedMessage[]): UnifiedMessage[] {
  const out: UnifiedMessage[] = [];
  let pendingPrefixBlocks: UnifiedBlock[] = [];

  for (let i = 0; i < messages.length; i++) {
    let msg = messages[i]!;
    if (pendingPrefixBlocks.length > 0) {
      msg = { role: msg.role, blocks: [...pendingPrefixBlocks, ...msg.blocks] };
      pendingPrefixBlocks = [];
    }
    out.push(msg);

    const calledIds = msg.blocks.filter(isToolCallBlock).map((b) => b.id);
    if (calledIds.length === 0) continue;

    const next = messages[i + 1];
    const answeredIds = new Set(next ? next.blocks.filter(isToolResultBlock).map((b) => b.toolCallId) : []);
    const missingIds = calledIds.filter((id) => !answeredIds.has(id));
    if (missingIds.length === 0) continue;

    const syntheticBlocks: UnifiedBlock[] = missingIds.map((id) => ({ type: "tool_result", toolCallId: id, content: "", isError: false, cache: false }));
    if (next !== undefined && next.role !== "assistant" && next.role !== "system") {
      pendingPrefixBlocks = syntheticBlocks;
    } else {
      out.push({ role: "tool", blocks: syntheticBlocks });
    }
  }
  return out;
}

/**
 * Rewrites every tool call/result id that doesn't match Anthropic's allowed
 * pattern. Applied through ONE shared substitution map so a `tool_call.id`
 * and every `tool_result.toolCallId` that references it get the SAME
 * replacement.
 */
export function sanitizeAnthropicToolIds(messages: UnifiedMessage[]): UnifiedMessage[] {
  const remap = new Map<string, string>();
  const used = new Set<string>();
  for (const msg of messages) {
    for (const b of msg.blocks) {
      if (isToolCallBlock(b) && ANTHROPIC_TOOL_ID_RE.test(b.id)) used.add(b.id);
      if (isToolResultBlock(b) && ANTHROPIC_TOOL_ID_RE.test(b.toolCallId)) used.add(b.toolCallId);
    }
  }
  let fallbackCounter = 0;

  function sanitize(id: string): string {
    if (ANTHROPIC_TOOL_ID_RE.test(id)) return id;
    const existing = remap.get(id);
    if (existing !== undefined) return existing;

    const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "");
    let candidate = cleaned.length > 0 ? cleaned : `tool_${fallbackCounter++}`;
    while (used.has(candidate)) candidate = `${candidate}_${fallbackCounter++}`;

    remap.set(id, candidate);
    used.add(candidate);
    return candidate;
  }

  return messages.map((msg) => ({
    role: msg.role,
    blocks: msg.blocks.map((b) => {
      if (isToolCallBlock(b)) return { ...b, id: sanitize(b.id) };
      if (isToolResultBlock(b)) return { ...b, toolCallId: sanitize(b.toolCallId) };
      return b;
    }),
  }));
}
