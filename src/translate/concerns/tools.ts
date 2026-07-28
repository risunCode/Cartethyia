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
