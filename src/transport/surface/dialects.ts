import type { ReasoningIntent, ResponseFormat, ToolChoice } from "../canonical-model";
import { REASONING_EFFORTS } from "../canonical-model";
import { readString, readBoolean, readNumber } from "../../protocol/primitives";
import { isRecord } from "../../protocol/primitives";
import type { ToolDefinition } from "../canonical-model";

/** Tool-definition dialects preserve each surface's distinct wire fields. */
export type ToolDialect = "chat" | "responses" | "messages";

/**
 * Parses a tool definition from one wire dialect.
 *
 * The parser intentionally keeps dialect-specific field precedence and does
 * not normalize message content or tool calls across surfaces.
 */
export function parseToolDefinition(
  value: unknown,
  dialect: ToolDialect,
): ToolDefinition | undefined {
  if (!isRecord(value)) return undefined;

  if (dialect === "messages") {
    const tool = value["tool"];
    if (isRecord(tool)) return parseToolObject(tool, "messages");
    return parseToolObject(value, "messages");
  }
  return parseToolObject(value, dialect);
}

function parseToolObject(item: Record<string, unknown>, dialect: ToolDialect): ToolDefinition | undefined {
  let name = readString(item, "name");
  if (name === undefined && dialect === "responses") {
    const type = readString(item, "type");
    if (type !== undefined) name = type;
  }
  const chatWrapper =
    dialect === "chat"
      ? isRecord(item["function"])
        ? item["function"]
        : isRecord(item["custom"])
          ? item["custom"]
          : undefined
      : undefined;
  if (chatWrapper !== undefined) {
    const wrapperName = readString(chatWrapper, "name");
    if (wrapperName !== undefined) name = wrapperName;
  }
  if (name === undefined) return undefined;

  let description = readString(item, "description");
  if (chatWrapper !== undefined) {
    const wrapperDescription = readString(chatWrapper, "description");
    if (wrapperDescription !== undefined) description = wrapperDescription;
  }

  let schema: unknown;
  if (dialect === "chat") {
    const custom = item["custom"];
    if (isRecord(custom)) {
      schema = custom["format"] ?? custom["jsonSchema"] ?? {};
    } else {
      const functionValue = item["function"];
      schema = isRecord(functionValue)
        ? functionValue["parameters"] ?? functionValue["jsonSchema"] ?? {}
        : {};
    }
  } else if (dialect === "responses") {
    schema = item["input_schema"] ?? item["parameters"] ?? item;
  } else {
    schema = item["input_schema"] ?? item["inputSchema"] ?? {};
  }

  const strict =
    (chatWrapper !== undefined ? readBoolean(chatWrapper, "strict") : undefined) ??
    readBoolean(item, "strict");
  const result: ToolDefinition = {
    name,
    jsonSchema: isRecord(schema) ? schema : {},
  };

  if (description !== undefined) result.description = description;
  if (strict !== undefined) result.strict = strict;
  if (Array.isArray(item["input_examples"]))
    result.input_examples = item["input_examples"].filter(isRecord);
  if (typeof item["defer_loading"] === "boolean") result.defer_loading = item["defer_loading"];
  if (Array.isArray(item["allowed_callers"])) {
    result.allowed_callers = item["allowed_callers"].filter(
      (caller): caller is "direct" | "programmatic" =>
        caller === "direct" || caller === "programmatic",
    );
  }
  if (dialect === "chat" && isRecord(item["function"])) {
    const fn = item["function"];
    if (result.input_examples === undefined && Array.isArray(fn["input_examples"]))
      result.input_examples = fn["input_examples"].filter(isRecord);
    if (result.defer_loading === undefined && typeof fn["defer_loading"] === "boolean")
      result.defer_loading = fn["defer_loading"];
    if (result.allowed_callers === undefined && Array.isArray(fn["allowed_callers"])) {
      result.allowed_callers = fn["allowed_callers"].filter(
        (caller): caller is "direct" | "programmatic" =>
          caller === "direct" || caller === "programmatic",
      );
    }
  }

  const type = readString(item, "type");
  if (dialect === "chat" && type === "custom") result.tool_type = "custom";
  else if (type !== undefined && type !== "function" && type !== "tool")
    result.tool_type = classifyNativeToolType(type);
  else if (type === "function" || type === "tool") result.tool_type = "function";
  else if (type !== undefined) result.tool_type = "function";
  return result;
}

function classifyNativeToolType(type: string): Exclude<ToolDefinition["tool_type"], undefined> {
  if (
    type === "web_search_preview" ||
    type === "web_search_preview_2025_03_11" ||
    type === "web_search_options"
  )
    return "web_search";
  if (type === "file_search") return "file_search";
  if (type === "code_interpreter" || type === "code_execution") return "code_execution";
  if (type === "computer_use_preview") return "computer_use";
  if (type === "mcp") return "mcp";
  return "provider";
}

export const CANONICAL_REASONING_EFFORTS: ReadonlySet<string> = new Set(REASONING_EFFORTS);

export function isReasoningEffort(value: unknown): value is NonNullable<ReasoningIntent["effort"]> {
  return typeof value === "string" && CANONICAL_REASONING_EFFORTS.has(value as NonNullable<ReasoningIntent["effort"]>);
}

export const SERVICE_TIERS = new Set(["auto", "default", "flex", "scale", "priority", "fast"]);

export function isServiceTier(value: unknown): value is string {
  return typeof value === "string" && SERVICE_TIERS.has(value);
}

/**
 * Dialect-unified tool_choice parser. Accepts string literals across all wires,
 * unwraps function/custom wrappers leniently, extracts allowed_tools names from both
 * `entry.function.name` (Chat wire) and `entry.name` (Responses wire), and enforces
 * strict-throw for Messages vs lenient-undefined for Chat/Responses.
 */
export function parseToolChoice(value: unknown, dialect: ToolDialect): ToolChoice | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "auto" || value === "none" || value === "required") return value;
  if (!isRecord(value)) {
    if (dialect === "messages") throw new Error("Messages tool_choice must be a string or object");
    return undefined;
  }
  const type = readString(value, "type");
  // Messages dialect aliases
  if (type === "auto") return "auto";
  if (type === "none") return "none";
  if (type === "any") return "required";

  if (type === "allowed_tools" && Array.isArray(value["tools"])) {
    const tools = value["tools"] as unknown[];
    const names = tools.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const fn = isRecord(entry["function"]) ? entry["function"] : entry;
      const name = readString(fn, "name");
      return name !== undefined ? [name] : [];
    });
    const mode = readString(value, "mode") === "required" ? ("required" as const) : ("auto" as const);
    return { type: "allowed_tools", mode, names };
  }
  if (type === "custom") {
    const customObj = isRecord(value["custom"]) ? value["custom"] : value;
    const name = readString(customObj, "name");
    if (name !== undefined) return { type: "custom", name };
  }
  if (type === "function" || type === "tool") {
    const fnObj = isRecord(value["function"]) ? value["function"] : value;
    const name = readString(fnObj, "name");
    if (name !== undefined) return { type: "tool", name };
  }
  if (dialect === "messages") throw new Error("Messages tool_choice has an unsupported type");
  return undefined;
}

/**
 * Normalized reasoning parser. Reads nested `reasoning` object (Responses wire)
 * and top-level `reasoning_effort`/`reasoning_level`/`summary_mode` scalars (Chat wire).
 */
export function parseReasoningIntent(body: Record<string, unknown>): ReasoningIntent | undefined {
  const reasoningObj = isRecord(body["reasoning"]) ? body["reasoning"] : undefined;
  const rawEffort = reasoningObj
    ? readString(reasoningObj, "effort")
    : (readString(body, "reasoning_effort") ?? readString(body, "reasoning_level"));
  const rawSummary = reasoningObj
    ? (readString(reasoningObj, "summary") ?? readString(reasoningObj, "summary_mode"))
    : readString(body, "summary_mode");
  const reasoning: ReasoningIntent = {};
  if (isReasoningEffort(rawEffort)) reasoning.effort = rawEffort;
  if (reasoningObj) {
    const mode = readString(reasoningObj, "mode");
    if (mode === "standard" || mode === "pro") reasoning.mode = mode;
    const context = readString(reasoningObj, "context");
    if (context === "current_turn" || context === "all_turns") reasoning.context = context;
    const thinkingType = readString(reasoningObj, "thinking_type");
    if (thinkingType === "enabled" || thinkingType === "adaptive" || thinkingType === "disabled")
      reasoning.thinking_type = thinkingType;
    const budget = readNumber(reasoningObj, "budget_tokens");
    if (budget !== undefined) reasoning.budget_tokens = budget;
  }
  if (rawSummary === "auto" || rawSummary === "concise" || rawSummary === "detailed") {
    reasoning.summary_mode = rawSummary;
  } else if (rawSummary !== undefined && reasoningObj) {
    reasoning.summary = rawSummary;
  }
  return Object.keys(reasoning).length > 0 ? reasoning : undefined;
}

/**
 * Normalized response_format parser. Supports OpenAI `body.response_format` and
 * Responses `body.text.format`. Returns undefined if `json_schema` schema payload is missing.
 */
export function parseResponseFormat(formatValue: unknown): ResponseFormat | undefined {
  if (!isRecord(formatValue)) return undefined;
  const type = readString(formatValue, "type");
  if (type === "json_object") return { type: "json_object" };
  if (type !== "json_schema") return undefined;
  const schemaObj = isRecord(formatValue["json_schema"]) ? formatValue["json_schema"] : formatValue;
  const schema = schemaObj["schema"] ?? schemaObj["json_schema"];
  if (schema === undefined) return undefined;
  const strict = readBoolean(schemaObj, "strict");
  const name = readString(schemaObj, "name");
  const description = readString(schemaObj, "description");
  return {
    type: "json_schema",
    schema,
    ...(typeof strict === "boolean" ? { strict } : {}),
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof description === "string" ? { description } : {}),
  };
}
