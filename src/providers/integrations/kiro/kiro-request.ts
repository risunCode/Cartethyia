// Canonical request → Kiro (CodeWhisperer) wire payload.
//
// The upstream does not take a chat-style body. It takes a `conversationState`
// holding a strict user/assistant ledger plus the current turn, and it rejects
// shapes it cannot reconcile with `400 REQUEST_BODY_INVALID`. Two consequences
// drive this module:
//
//  1. A conversation that cannot be expressed is refused here, locally. The
//     upstream's 400 is terminal for the account (it cools every account down),
//     so spending a request on a body we already know is malformed costs more
//     than the request.
//  2. The system prompt does not travel in a field of its own — a top-level
//     `systemPrompt` is itself one of the shapes that earns the 400. It is
//     prefixed onto the opening user turn instead, and thinking is requested by
//     a marker prefix in that same text.
//
// Tool names and ids are rewritten on the way out because the upstream accepts
// only `[a-zA-Z0-9_-]` within fixed lengths, and the mapping is returned so the
// response side can restore the caller's own names.

import { createHash, randomUUID } from "node:crypto";
import type { CanonicalMessage, CanonicalRequest, ContentPart, ToolDefinition } from "../../../protocol/canonical-model";
import { resolveImageSource, splitDataUrl } from "../../../protocol/codecs";
import type { ReasoningEffortLevel } from "../../../transport/translation/thinking";

/** Longest tool name the upstream accepts, counted in code points. */
export const KIRO_TOOL_NAME_MAX_LENGTH = 64;
/** Longest tool description the upstream accepts, counted in code points. */
export const KIRO_TOOL_DESCRIPTION_MAX_LENGTH = 10_237;
/** Longest tool call id the upstream accepts, counted in code points. */
export const KIRO_TOOL_ID_MAX_LENGTH = 64;
/** Default thinking budget when a caller asks for thinking without a size. */
export const KIRO_THINKING_BUDGET_DEFAULT = 16_000;
/** Upstream ceiling on the thinking budget marker. */
export const KIRO_THINKING_BUDGET_MAX = 32_000;

/**
 * Text substituted for a user turn that would otherwise be empty. The upstream
 * rejects empty content, and an empty string makes the model answer the
 * placeholder itself, so the two cases get different wording: a turn that
 * carries tool results is complete as-is, while a turn with nothing at all
 * needs the model to continue.
 */
export const KIRO_TOOL_RESULTS_PLACEHOLDER = "Tool results provided.";
export const KIRO_EMPTY_USER_PLACEHOLDER = "continue";
/** Text substituted for an empty assistant turn. */
export const KIRO_EMPTY_ASSISTANT_PLACEHOLDER = "...";

/** One `toolSpecification` entry in the wire payload. */
interface KiroToolSpecification {
  readonly toolSpecification: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: { readonly json: Record<string, unknown> };
  };
}

/** One entry of `currentMessage.userInputMessage.userInputMessageContext`. */
interface KiroUserInputContext {
  readonly toolResults?: readonly KiroToolResult[];
  readonly tools?: readonly KiroToolSpecification[];
}

interface KiroToolResult {
  readonly toolUseId: string;
  readonly status: "success" | "error";
  readonly content: readonly { readonly text: string }[];
}

interface KiroToolUse {
  readonly toolUseId: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface KiroUserInputMessage {
  readonly content: string;
  readonly modelId?: string;
  readonly origin?: "AI_EDITOR";
  readonly images?: readonly unknown[];
  readonly userInputMessageContext?: KiroUserInputContext;
}

interface KiroAssistantMessage {
  readonly content: string;
  readonly toolUses?: readonly KiroToolUse[];
}

type KiroHistoryEntry =
  | { readonly userInputMessage: KiroUserInputMessage }
  | { readonly assistantResponseMessage: KiroAssistantMessage };

/** The wire payload plus the bookkeeping the response side needs. */
export interface KiroWireRequest {
  readonly payload: Record<string, unknown>;
  /** Sanitized tool name → the caller's original name, for restoring tool calls. */
  readonly toolNameMap: ReadonlyMap<string, string>;
}

/** Why a conversation could not be expressed on this wire. */
export interface KiroConversationError {
  /** Per-turn taxonomy: `role:N`, `pair:N`, `id:N`, `spec:N`, `orphan:0`, `current`. */
  readonly problems: readonly string[];
}

/** Options the adapter supplies that are not part of the canonical request. */
export interface KiroWireRequestOptions {
  readonly conversationId: string;
  readonly modelId: string;
  readonly profileArn: string;
  /** Reasoning effort the routed model advertises, already validated by the adapter. */
  readonly effort?: ReasoningEffortLevel | undefined;
  /** Thinking budget marker; omitted when the model takes a native effort field. */
  readonly thinkingBudget?: number | undefined;
  /** Whether the effort is sent as `output_config.effort` (Claude) or `reasoning.effort` (GPT). */
  readonly effortPath?: "output_config" | "reasoning" | undefined;
}

/**
 * Builds the wire payload, or reports why the conversation cannot be sent.
 *
 * Returns `undefined` only for a conversation defect — a shape the upstream
 * would reject. Everything else is normalized rather than refused.
 */
export function buildKiroWireRequest(
  request: CanonicalRequest,
  options: KiroWireRequestOptions,
): { readonly ok: true; readonly value: KiroWireRequest } | { readonly ok: false; readonly error: KiroConversationError } {
  const toolNameMap = new Map<string, string>();
  const wireNameByOriginal = new Map<string, string>();
  const specs = normalizeToolSpecs(request.tools ?? [], toolNameMap, wireNameByOriginal);
  const usedToolIds = new Set<string>();

  const prefix = buildStablePrefix(request, options);
  const { history, current, problems } = splitConversation(request.messages, {
    modelId: options.modelId,
    prefix,
    wireNameByOriginal,
    usedToolIds,
    now: new Date(),
  });
  if (problems.length > 0) return { ok: false, error: { problems } };

  const currentMessage: KiroUserInputMessage = {
    content: current.content,
    modelId: options.modelId,
    origin: "AI_EDITOR",
    ...(current.images && current.images.length > 0 ? { images: current.images } : {}),
    ...(specs.length > 0 || (current.toolResults && current.toolResults.length > 0)
      ? {
          userInputMessageContext: {
            ...(current.toolResults && current.toolResults.length > 0
              ? { toolResults: current.toolResults }
              : {}),
            // Tool definitions travel only on the current turn; the upstream
            // ignores them anywhere else in the ledger.
            ...(specs.length > 0 ? { tools: specs } : {}),
          },
        }
      : {}),
  };

  const payload: Record<string, unknown> = {
    conversationState: {
      // The upstream distinguishes a plain conversation from an agent task, and
      // a request that declares tools is the latter. Sending the plain kind with
      // tool definitions attached is a combination the real client never emits.
      agentTaskType: specs.length > 0 ? "spectask" : "vibe",
      // A fresh per-request continuation id, which is what the observed client
      // sends. It is not the conversation id: the conversation id stays stable
      // for the session, while this one marks the run.
      agentContinuationId: randomUUID(),
      chatTriggerType: "MANUAL",
      conversationId: options.conversationId,
      currentMessage: { userInputMessage: currentMessage },
      history,
    },
  };
  if (options.profileArn.length > 0) payload.profileArn = options.profileArn;
  const additionalModelRequestFields = buildAdditionalModelRequestFields(options);
  if (additionalModelRequestFields !== undefined) {
    payload.additionalModelRequestFields = additionalModelRequestFields;
  }
  return { ok: true, value: { payload, toolNameMap } };
}

/**
 * Builds the text that precedes the opening user turn: the thinking marker and
/**
 * Builds the text that opens the ledger: the thinking marker and the caller's
 * system text.
 *
 * This text is deliberately the *only* thing the opening turn carries besides
 * the caller's own words, because it is the prefix the upstream caches: every
 * request in a conversation repeats it byte-for-byte on that same turn. A value
 * that changes per request belongs on the current turn instead — see
 * `buildCurrentTimeLine`.
 */
function buildStablePrefix(request: CanonicalRequest, options: KiroWireRequestOptions): string {
  const parts: string[] = [];
  if (options.thinkingBudget !== undefined) {
    parts.push(buildThinkingMarker(options.thinkingBudget));
  }
  const systemText = [...(request.system ?? []), ...(request.instructions ?? [])]
    .filter((part): part is Extract<ContentPart, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n\n");
  if (systemText.trim().length > 0) parts.push(systemText);
  return parts.join("\n\n");
}

/**
 * The line that tells the model when this turn was sent.
 *
 * It is built per request and placed on the current turn only, never in the
 * cached prefix: an opening turn carrying a fresh timestamp would make the
 * prefix differ on every request, so the upstream could never reuse the cached
 * one and the whole conversation would be re-read each turn.
 */
export function buildCurrentTimeLine(now: Date = new Date()): string {
  return `[Context: Current time is ${now.toISOString()}]`;
}

/** The marker the upstream reads to enable thinking with a budget. */
export function buildThinkingMarker(budget: number): string {
  const safe = Math.max(1, Math.min(KIRO_THINKING_BUDGET_MAX, Math.trunc(budget)));
  return `<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>${safe}</max_thinking_length>`;
}

/**
 * The thinking budget an effort tier asks for, or `undefined` for no reasoning.
 *
 * A model with no native effort field is asked to think through the text marker,
 * and the marker takes a token budget rather than a tier name. The tiers are
 * spaced so each step is a visibly different amount of thinking rather than a
 * nominal one, and `none` maps to no marker at all — the upstream has no
 * "reason a little" marker, and sending a token floor for "do not reason" would
 * request the opposite of what was asked.
 */
export function kiroThinkingBudgetForEffort(effort: string | undefined): number | undefined {
  switch (effort) {
    case "minimal":
      return 512;
    case "low":
      return 1_024;
    case "medium":
      return 8_192;
    case "high":
      return KIRO_THINKING_BUDGET_DEFAULT;
    case "xhigh":
      return KIRO_THINKING_BUDGET_MAX;
    // `max` is the top of the canonical ladder and the marker's ceiling is
    // `KIRO_THINKING_BUDGET_MAX`, so it saturates there rather than being
    // refused — asking for the most thinking the model will do is answerable.
    case "max":
      return KIRO_THINKING_BUDGET_MAX;
    default:
      return undefined;
  }
}

/**
 * Builds `additionalModelRequestFields`, or `undefined` when the model takes no
 * effort field.
 *
 * Two schemas exist upstream and they are not interchangeable: the newer Claude
 * models take `{thinking, output_config}`, the GPT family takes `{reasoning}`.
 * Sending the wrong one, or either one to a model that supports neither, is
 * rejected — which is why the adapter decides the path from the model id rather
 * than defaulting to one.
 */
function buildAdditionalModelRequestFields(
  options: KiroWireRequestOptions,
): Record<string, unknown> | undefined {
  if (options.effortPath === undefined || options.effort === undefined) return undefined;
  if (options.effortPath === "reasoning") {
    const effort = options.effort === "max" ? "xhigh" : options.effort;
    // `minimal` has no wire value on this schema; the upstream's lowest
    // advertised tier is `low`, so it maps there rather than being dropped.
    const normalized = effort === "minimal" ? "low" : effort;
    if (!["low", "medium", "high", "xhigh"].includes(normalized)) return undefined;
    return { reasoning: { effort: normalized } };
  }
  // The output_config schema collapses the top of the ladder: it has no `xhigh`
  // or `max` tier, and both mean "as much as this model will do".
  const effort = options.effort === "xhigh" || options.effort === "max" ? "high" : options.effort;
  if (!["low", "medium", "high"].includes(effort)) return undefined;
  return {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort },
  };
}

/**
 * Splits canonical messages into the upstream's ledger plus the current turn.
 *
 * The upstream requires strict user/assistant alternation, a final user turn,
 * and tool results immediately after the assistant turn that called them.
 * Canonical input from any surface can violate all three, so this function
 * repairs what it can (merging adjacent same-role turns, pairing a tool result
 * with its call) and reports only what it cannot: a call with no result, a
 * result with no call, or a tool name the request never defined.
 */
function splitConversation(
  messages: readonly CanonicalMessage[],
  context: {
    readonly modelId: string;
    readonly prefix: string;
    /** The caller's tool name → the wire-safe name it was rewritten to. */
    readonly wireNameByOriginal: ReadonlyMap<string, string>;
    readonly usedToolIds: Set<string>;
    /** When this request is being built, for the current turn's time line. */
    readonly now: Date;
  },
): {
  readonly history: readonly KiroHistoryEntry[];
  readonly current: {
    readonly content: string;
    readonly images?: readonly unknown[];
    readonly toolResults?: readonly KiroToolResult[];
  };
  readonly problems: readonly string[];
} {
  const problems: string[] = [];
  const turns: KiroHistoryEntry[] = [];
  const reservedByRawId = new Map<string, string>();
  const callIds: string[] = [];
  const resultIds: string[] = [];

  for (const [index, message] of messages.entries()) {
    const textParts = message.content.filter(
      (part): part is Extract<ContentPart, { kind: "text" }> => part.kind === "text",
    );
    const text = textParts.map((part) => part.text).join("");

    if (message.role === "assistant") {
      const toolCalls = message.content.filter(
        (part): part is Extract<ContentPart, { kind: "toolCall" }> => part.kind === "toolCall",
      );
      const toolUses: KiroToolUse[] = [];
      for (const call of toolCalls) {
        const name = context.wireNameByOriginal.get(call.name);
        if (name === undefined) {
          problems.push(`spec:${index}`);
          continue;
        }
        const input = normalizeToolInput(call.arguments);
        if (input === undefined) {
          problems.push(`id:${index}`);
          continue;
        }
        const toolUseId = reserveToolId(
          call.call_id,
          index,
          toolUses.length,
          name,
          context.usedToolIds,
          reservedByRawId,
        );
        callIds.push(toolUseId);
        toolUses.push({ toolUseId, name, input });
      }
      turns.push({
        assistantResponseMessage: {
          content: text.length > 0 ? text : KIRO_EMPTY_ASSISTANT_PLACEHOLDER,
          ...(toolUses.length > 0 ? { toolUses } : {}),
        },
      });
      continue;
    }

    // User and tool turns both become a user turn; tool results ride in the
    // context rather than the text.
    const toolResults: KiroToolResult[] = [];
    for (const part of message.content) {
      if (part.kind !== "toolResult") continue;
      const toolUseId = reserveToolId(
        part.call_id,
        index,
        toolResults.length,
        "tool",
        context.usedToolIds,
        reservedByRawId,
      );
      resultIds.push(toolUseId);
      toolResults.push({
        toolUseId,
        status: part.is_error === true ? "error" : "success",
        content: [{ text: toolResultText(part.content) }],
      });
    }
    const images = imagesOf(message);
    turns.push({
      userInputMessage: {
        content: text.length > 0 ? text : toolResults.length > 0 ? KIRO_TOOL_RESULTS_PLACEHOLDER : KIRO_EMPTY_USER_PLACEHOLDER,
        modelId: context.modelId,
        ...(images.length > 0 ? { images } : {}),
        ...(toolResults.length > 0 ? { userInputMessageContext: { toolResults } } : {}),
      },
    });
  }

  // The upstream requires strict alternation, so adjacent same-role turns are
  // merged rather than refused: a surface that legitimately produces two user
  // turns in a row (an injected system note, a replayed tool result) must not
  // turn into a 400.
  const merged: KiroHistoryEntry[] = [];
  for (const turn of turns) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && "userInputMessage" in previous && "userInputMessage" in turn) {
      merged[merged.length - 1] = {
        userInputMessage: mergeUserTurns(previous.userInputMessage, turn.userInputMessage),
      };
      continue;
    }
    if (
      previous !== undefined &&
      "assistantResponseMessage" in previous &&
      "assistantResponseMessage" in turn
    ) {
      merged[merged.length - 1] = {
        assistantResponseMessage: {
          content: `${previous.assistantResponseMessage.content}\n\n${turn.assistantResponseMessage.content}`.trim(),
          ...(turn.assistantResponseMessage.toolUses ?? previous.assistantResponseMessage.toolUses
            ? {
                toolUses: [
                  ...(previous.assistantResponseMessage.toolUses ?? []),
                  ...(turn.assistantResponseMessage.toolUses ?? []),
                ],
              }
            : {}),
        },
      };
      continue;
    }
    merged.push(turn);
  }

  // A tool result whose call never appeared, or a call whose result never
  // arrived, cannot be reconciled: the upstream matches them positionally.
  for (const id of resultIds) {
    if (!callIds.includes(id)) problems.push(`pair:${messages.length - 1}`);
  }
  for (const id of callIds) {
    if (!resultIds.includes(id)) problems.push(`pair:${messages.length - 1}`);
  }
  if (problems.length > 0) {
    return { history: [], current: { content: KIRO_EMPTY_USER_PLACEHOLDER }, problems: [...new Set(problems)] };
  }

  // The last turn must be the user's, and it is the only turn that may carry
  // the request's own tool definitions and images.
  const last = merged[merged.length - 1];
  if (last === undefined) {
    problems.push("current");
    return { history: [], current: { content: KIRO_EMPTY_USER_PLACEHOLDER }, problems };
  }
  if ("assistantResponseMessage" in last) {
    merged.push({
      userInputMessage: { content: KIRO_EMPTY_USER_PLACEHOLDER, modelId: context.modelId },
    });
  }
  const turns2 = merged;

  const currentTurn = turns2[turns2.length - 1];
  if (currentTurn === undefined || !("userInputMessage" in currentTurn)) {
    problems.push("current");
    return { history: [], current: { content: KIRO_EMPTY_USER_PLACEHOLDER }, problems };
  }

  // Images travel on the current turn only, and they are read from the turn the
  // ledger actually sends rather than from the last canonical message: a
  // conversation whose final turns were merged carries their images on the
  // merged turn, and reading the raw message would drop every image that was not
  // on the very last one.
  const images = currentTurn.userInputMessage.images ?? [];
  const history = turns2.slice(0, -1);
  // The opening user turn carries the stable prefix — the system text and the
  // thinking marker — and nothing else of ours, so a replayed conversation
  // repeats it byte-for-byte and the upstream can reuse the cached prefix. The
  // current-time line is volatile and rides the current turn instead.
  const timeLine = buildCurrentTimeLine(context.now);
  if (history.length > 0) {
    const first = history[0];
    if (first !== undefined && "userInputMessage" in first) {
      history[0] = {
        userInputMessage: {
          ...first.userInputMessage,
          content: `${context.prefix}\n\n${first.userInputMessage.content}`.trim(),
        },
      };
    }
  } else {
    // A single-turn conversation: the prefix belongs on the current turn, and so
    // does the time line, because there is no earlier turn to carry it.
    return {
      history: [],
      current: {
        content: `${context.prefix}\n\n${timeLine}\n\n${currentTurn.userInputMessage.content}`.trim(),
        ...(currentTurn.userInputMessage.userInputMessageContext?.toolResults
          ? { toolResults: currentTurn.userInputMessage.userInputMessageContext.toolResults }
          : {}),
        ...(images.length > 0 ? { images } : {}),
      },
      problems,
    };
  }

  const currentToolResults = currentTurn.userInputMessage.userInputMessageContext?.toolResults;
  return {
    history,
    current: {
      content: `${timeLine}\n\n${currentTurn.userInputMessage.content}`.trim(),
      ...(currentToolResults ? { toolResults: currentToolResults } : {}),
      ...(images.length > 0 ? { images } : {}),
    },
    problems,
  };
}

/**
 * Merges two adjacent user turns into one.
 *
 * Text joins with a blank line and tool results concatenate, because dropping
 * either would silently lose a result the model is about to be asked about.
 */
function mergeUserTurns(first: KiroUserInputMessage, second: KiroUserInputMessage): KiroUserInputMessage {
  const firstResults = first.userInputMessageContext?.toolResults ?? [];
  const secondResults = second.userInputMessageContext?.toolResults ?? [];
  const toolResults = [...firstResults, ...secondResults];
  const images = [...(first.images ?? []), ...(second.images ?? [])];
  const modelId = first.modelId ?? second.modelId;
  return {
    content: `${first.content}\n\n${second.content}`.trim(),
    ...(modelId === undefined ? {} : { modelId }),
    ...(images.length > 0 ? { images } : {}),
    ...(toolResults.length > 0 ? { userInputMessageContext: { toolResults } } : {}),
  };
}

/** Extracts image parts from a message into the upstream's `images` shape. */
function imagesOf(message: CanonicalMessage): readonly unknown[] {
  const images: unknown[] = [];
  for (const part of message.content) {
    if (part.kind !== "image") continue;
    const encoded = imagePayload(part.payload);
    if (encoded === undefined) continue;
    images.push({ format: encoded.format, source: { bytes: encoded.bytes } });
  }
  return images;
}

/**
 * Reads an inline image into the upstream's `{format, bytes}` shape.
 *
 * Resolution goes through the shared `resolveImageSource` primitive rather than
 * a local re-implementation. The canonical image payload is opaque and each
 * surface spells it differently — an OpenAI Chat caller sends
 * `{type:"image_url", image_url:{url:"data:image/png;base64,…"}}`, Anthropic
 * sends `{source:{type:"base64", media_type, data}}` — and a local arm that
 * recognised only one of them dropped every other shape silently while the
 * request still succeeded. That is exactly how the model came to answer "I don't
 * see any image attached" for a request that carried one.
 *
 * The upstream takes inline bytes only: a remote URL is not fetchable by it, so
 * an image that is not a base64 `data:` URL is reported as a placeholder the
 * model can see rather than dropped.
 */
function imagePayload(payload: unknown): { readonly format: string; readonly bytes: string } | undefined {
  const source = resolveImageSource(payload);
  if (source === undefined) return undefined;
  if (source.url !== undefined) {
    const split = splitDataUrl(source.url);
    if (split === undefined) return undefined;
    return { format: mediaTypeToKiroFormat(split.mediaType), bytes: split.data };
  }
  return undefined;
}

/**
 * Maps a declared media type onto the format token the upstream expects.
 *
 * The token is the subtype the caller declared (`image/png` → `png`), because
 * that is the only statement about the bytes anyone made. A type with no subtype
 * falls back to `png` rather than being guessed from the bytes.
 */
function mediaTypeToKiroFormat(mediaType: string): string {
  const subtype = mediaType.includes("/") ? mediaType.slice(mediaType.indexOf("/") + 1) : mediaType;
  return subtype.length > 0 ? subtype.toLowerCase() : "png";
}

/** Flattens a tool result's content into the single text block the wire accepts. */
function toolResultText(content: readonly ContentPart[] | string): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.kind === "text") return part.text;
      if (part.kind === "image") return "[image]";
      return "";
    })
    .join("");
}

/**
 * Reserves a wire-safe tool id, keeping the caller's id when it already fits.
 *
 * The upstream matches a call to its result by this exact string, so a call and
 * its result must land on the same value. `reservedByRawId` is what makes that
 * hold: the first reservation of a raw id wins and every later use of that id —
 * the result that answers it, a replay — reuses it instead of taking the next
 * free suffix. Only genuinely distinct ids are de-duplicated.
 */
function reserveToolId(
  rawId: string,
  turnIndex: number,
  callIndex: number,
  name: string,
  used: Set<string>,
  reservedByRawId: Map<string, string>,
): string {
  const raw = String(rawId);
  const existing = reservedByRawId.get(raw);
  if (existing !== undefined) return existing;
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, "");
  const base =
    sanitized.length > 0
      ? trimCodePoints(sanitized, KIRO_TOOL_ID_MAX_LENGTH)
      : trimCodePoints(`call_msg${turnIndex}_tc${callIndex}_${name || "tool"}`, KIRO_TOOL_ID_MAX_LENGTH);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = `_${suffix}`;
    candidate = `${trimCodePoints(base, KIRO_TOOL_ID_MAX_LENGTH - tail.length)}${tail}`;
    suffix += 1;
  }
  used.add(candidate);
  reservedByRawId.set(raw, candidate);
  return candidate;
}

/** Parses tool-call arguments into the JSON object the wire requires. */
function normalizeToolInput(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Normalizes the request's tool definitions into wire specifications.
 *
 * Names are sanitized and de-duplicated because the upstream identifies a tool
 * by name; the caller's original name is recorded in `nameMap` so a tool call
 * can be reported back under the name the caller used.
 *
 * An over-long name is shortened by hashing the tail rather than by truncating
 * it: two tools that differ only past the limit must not collapse onto one
 * wire name, or a call for one arrives as a call for the other.
 */
function normalizeToolSpecs(
  tools: readonly ToolDefinition[],
  nameMap: Map<string, string>,
  wireNameByOriginal: Map<string, string>,
): readonly KiroToolSpecification[] {
  const specs: KiroToolSpecification[] = [];
  const taken = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    const rawName = typeof tool.name === "string" ? tool.name.trim() : "";
    if (rawName.length === 0) continue;
    const base = wireToolName(rawName, index);
    let name = base;
    let suffix = 2;
    while (taken.has(name)) {
      const tail = `_${suffix}`;
      name = `${trimCodePoints(base, KIRO_TOOL_NAME_MAX_LENGTH - tail.length)}${tail}`;
      suffix += 1;
    }
    taken.add(name);
    wireNameByOriginal.set(rawName, name);
    if (name !== rawName) nameMap.set(name, rawName);
    const description =
      typeof tool.description === "string" && tool.description.trim().length > 0
        ? trimCodePoints(tool.description, KIRO_TOOL_DESCRIPTION_MAX_LENGTH)
        : `Tool: ${rawName}`;
    specs.push({
      toolSpecification: { name, description, inputSchema: { json: normalizeJsonSchema(tool.jsonSchema) } },
    });
  }
  return specs;
}

/**
 * Rewrites a caller's tool name into one the upstream accepts.
 *
 * The upstream allows only `[a-zA-Z0-9_-]` within a fixed length. A name that
 * fits is returned as-is; an over-long one keeps a readable prefix and appends a
 * hash of the whole original, so the result is unique per input rather than
 * merely truncated.
 */
export function wireToolName(rawName: string, index: number): string {
  const sanitized = rawName.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  if (sanitized.length === 0) return `tool_${index + 1}`;
  if ([...sanitized].length <= KIRO_TOOL_NAME_MAX_LENGTH) return sanitized;
  const hash = createHash("sha256").update(sanitized).digest("hex").slice(0, 12);
  const prefixLength = KIRO_TOOL_NAME_MAX_LENGTH - hash.length - 1;
  return `${trimCodePoints(sanitized, prefixLength)}_${hash}`;
}

/**
 * Normalizes a tool's JSON schema for the upstream.
 *
 * The upstream rejects `additionalProperties` and an empty `required` array,
 * and requires the root to be an object schema with a `properties` map, so
 * those are repaired here rather than left to earn a 400.
 */
export function normalizeJsonSchema(schema: unknown): Record<string, unknown> {
  const root = schema !== null && typeof schema === "object" && !Array.isArray(schema)
    ? { ...(schema as Record<string, unknown>) }
    : {};
  delete root.additionalProperties;
  root.type = "object";
  const properties = root.properties;
  root.properties =
    properties !== null && typeof properties === "object" && !Array.isArray(properties)
      ? (properties as Record<string, unknown>)
      : {};
  const required = root.required;
  if (Array.isArray(required)) {
    const names = new Set(Object.keys(root.properties as Record<string, unknown>));
    const filtered = [...new Set(required.filter((entry): entry is string => typeof entry === "string" && names.has(entry)))];
    if (filtered.length > 0) root.required = filtered;
    else delete root.required;
  } else if (required !== undefined) {
    delete root.required;
  }
  return root;
}

/** Truncates to a code-point budget, never splitting a surrogate pair. */
function trimCodePoints(value: string, maxLength: number): string {
  const points = [...value];
  return points.length > maxLength ? points.slice(0, maxLength).join("") : value;
}

/** A conversation id for a request that carried none. */
export function generateKiroConversationId(): string {
  return randomUUID();
}
