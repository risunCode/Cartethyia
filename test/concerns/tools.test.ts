import { describe, expect, test } from "bun:test";
import {
  anthropicToolChoiceToOpenAIChat,
  anthropicToolToUnified,
  openAIChatToolChoiceToResponses,
  openAIChatToolToUnified,
  openAIResponsesToolToUnified,
  openAIToolChoiceToAnthropic,
  parseToolArguments,
  responsesToolChoiceToOpenAIChat,
  stringifyToolArguments,
  unifiedToolToAnthropic,
  unifiedToolToOpenAIChat,
  unifiedToolToOpenAIResponses,
} from "../../src/translate/concerns/tools";
import type { UnifiedToolDef } from "../../src/translate/concerns/tools";

const schema = { type: "object", properties: { x: { type: "number" } } };

describe("tools concern — schema round-trips", () => {
  test("Anthropic → unified → Anthropic preserves name/description/schema", () => {
    const unified = anthropicToolToUnified({ name: "get_weather", description: "fetch weather", input_schema: schema });
    expect(unified).toEqual({ name: "get_weather", description: "fetch weather", schema });
    expect(unifiedToolToAnthropic(unified)).toEqual({ name: "get_weather", description: "fetch weather", input_schema: schema });
  });

  test("Anthropic tool without description round-trips without adding one", () => {
    const unified = anthropicToolToUnified({ name: "ping", input_schema: schema });
    expect(unified.description).toBeUndefined();
    expect(unifiedToolToAnthropic(unified)).toEqual({ name: "ping", input_schema: schema });
  });

  test("OpenAI Chat (nested function) → unified → OpenAI Chat round-trips", () => {
    const unified = openAIChatToolToUnified({ type: "function", function: { name: "get_weather", description: "d", parameters: schema } });
    expect(unified).toEqual({ name: "get_weather", description: "d", schema });
    expect(unifiedToolToOpenAIChat(unified)).toEqual({ type: "function", function: { name: "get_weather", description: "d", parameters: schema } });
  });

  test("OpenAI Responses (flat) → unified → OpenAI Responses round-trips", () => {
    const unified = openAIResponsesToolToUnified({ type: "function", name: "get_weather", description: "d", parameters: schema });
    expect(unified).toEqual({ name: "get_weather", description: "d", schema });
    expect(unifiedToolToOpenAIResponses(unified)).toEqual({ type: "function", name: "get_weather", description: "d", parameters: schema });
  });

  test("cross-surface: Anthropic tool def renders correctly as OpenAI Chat def", () => {
    const unified: UnifiedToolDef = anthropicToolToUnified({ name: "x", input_schema: schema });
    expect(unifiedToolToOpenAIChat(unified)).toEqual({ type: "function", function: { name: "x", parameters: schema } });
  });
});

describe("tools concern \u2014 missing schema defaults to an empty object schema", () => {
  // A zero-argument tool that omits parameters/input_schema entirely (some
  // clients don't fill in the empty-object default) must never leave the
  // wire's schema field undefined - Anthropic requires input_schema, and
  // JSON.stringify silently drops an undefined key, rejecting the WHOLE
  // request instead of just that one under-specified tool.
  const EMPTY_SCHEMA = { type: "object", properties: {} };

  test("OpenAI Chat tool without `parameters` gets a default empty-object schema, not undefined", () => {
    const unified = openAIChatToolToUnified({ type: "function", function: { name: "list_files" } });
    expect(unified.schema).toEqual(EMPTY_SCHEMA);
    expect(unifiedToolToAnthropic(unified).input_schema).toEqual(EMPTY_SCHEMA);
  });

  test("OpenAI Responses tool without `parameters` gets a default empty-object schema", () => {
    const unified = openAIResponsesToolToUnified({ type: "function", name: "list_files" });
    expect(unified.schema).toEqual(EMPTY_SCHEMA);
  });

  test("Anthropic tool without `input_schema` gets a default empty-object schema", () => {
    const unified = anthropicToolToUnified({ name: "list_files" });
    expect(unified.schema).toEqual(EMPTY_SCHEMA);
    expect(unifiedToolToOpenAIChat(unified).function.parameters).toEqual(EMPTY_SCHEMA);
  });

  test("an empty object schema ({}) is also treated as missing and gets the default", () => {
    const unified = openAIChatToolToUnified({ type: "function", function: { name: "ping", parameters: {} } });
    expect(unified.schema).toEqual(EMPTY_SCHEMA);
  });

  test("a real, non-empty schema is never overwritten by the default", () => {
    const unified = openAIChatToolToUnified({ type: "function", function: { name: "get_weather", parameters: schema } });
    expect(unified.schema).toEqual(schema);
  });
});

describe("tools concern — argument (de)serialization", () => {
  test("parseToolArguments parses well-formed JSON object", () => {
    expect(parseToolArguments('{"city":"Jakarta"}')).toEqual({ city: "Jakarta" });
  });

  test("parseToolArguments on empty string returns {}", () => {
    expect(parseToolArguments("")).toEqual({});
  });

  test("parseToolArguments never throws on malformed JSON — defaults to {}", () => {
    expect(parseToolArguments("{not valid json")).toEqual({});
  });

  test("parseToolArguments rejects non-object JSON (array/primitive) — defaults to {}", () => {
    expect(parseToolArguments("[1,2,3]")).toEqual({});
    expect(parseToolArguments("42")).toEqual({});
    expect(parseToolArguments("null")).toEqual({});
  });

  test("stringifyToolArguments produces valid JSON parseable back to the same object", () => {
    const input = { city: "Jakarta", days: 3 };
    const json = stringifyToolArguments(input);
    expect(parseToolArguments(json)).toEqual(input);
  });
});

describe("tools concern — tool_choice conversion", () => {
  test("OpenAI Chat 'auto' → Anthropic: omitted (Anthropic's default is already auto)", () => {
    expect(openAIToolChoiceToAnthropic("auto")).toBeUndefined();
    expect(openAIToolChoiceToAnthropic(undefined)).toBeUndefined();
  });

  test("OpenAI Chat 'none' → Anthropic {type:'none'} — the client's don't-call-tools intent must survive", () => {
    expect(openAIToolChoiceToAnthropic("none")).toEqual({ type: "none" });
  });

  test("OpenAI Chat 'required' → Anthropic {type:'any'}", () => {
    expect(openAIToolChoiceToAnthropic("required")).toEqual({ type: "any" });
  });

  test("OpenAI Chat named function choice → Anthropic {type:'tool', name}", () => {
    expect(openAIToolChoiceToAnthropic({ type: "function", function: { name: "get_weather" } })).toEqual({ type: "tool", name: "get_weather" });
  });

  test("Anthropic {type:'tool', name} → OpenAI Chat named function choice", () => {
    expect(anthropicToolChoiceToOpenAIChat({ type: "tool", name: "get_weather" })).toEqual({ type: "function", function: { name: "get_weather" } });
  });

  test("Anthropic {type:'none'} → OpenAI Chat 'none'", () => {
    expect(anthropicToolChoiceToOpenAIChat({ type: "none" })).toBe("none");
  });

  test("Anthropic {type:'any'} → OpenAI Chat 'required'", () => {
    expect(anthropicToolChoiceToOpenAIChat({ type: "any" })).toBe("required");
  });

  test("Anthropic {type:'auto'} → OpenAI Chat undefined (auto is the unset default)", () => {
    expect(anthropicToolChoiceToOpenAIChat({ type: "auto" })).toBeUndefined();
    expect(anthropicToolChoiceToOpenAIChat(undefined)).toBeUndefined();
  });

  test("OpenAI Chat named choice → Responses flat shape (not nested under 'function')", () => {
    expect(openAIChatToolChoiceToResponses({ type: "function", function: { name: "get_weather" } })).toEqual({ type: "function", name: "get_weather" });
  });

  test("OpenAI Chat string choices pass through unchanged to Responses", () => {
    expect(openAIChatToolChoiceToResponses("auto")).toBe("auto");
    expect(openAIChatToolChoiceToResponses("none")).toBe("none");
    expect(openAIChatToolChoiceToResponses("required")).toBe("required");
    expect(openAIChatToolChoiceToResponses(undefined)).toBeUndefined();
  });

  test("Responses flat named choice → Chat nested shape", () => {
    expect(responsesToolChoiceToOpenAIChat({ type: "function", name: "get_weather" })).toEqual({ type: "function", function: { name: "get_weather" } });
  });

  test("Responses string choices pass through unchanged to Chat", () => {
    expect(responsesToolChoiceToOpenAIChat("auto")).toBe("auto");
    expect(responsesToolChoiceToOpenAIChat("none")).toBe("none");
    expect(responsesToolChoiceToOpenAIChat("required")).toBe("required");
    expect(responsesToolChoiceToOpenAIChat(undefined)).toBeUndefined();
  });

  test("Chat → Anthropic → Chat round-trips a named function choice", () => {
    const original: Parameters<typeof openAIToolChoiceToAnthropic>[0] = { type: "function", function: { name: "search" } };
    const anthropic = openAIToolChoiceToAnthropic(original);
    expect(anthropicToolChoiceToOpenAIChat(anthropic)).toEqual(original);
  });
});
