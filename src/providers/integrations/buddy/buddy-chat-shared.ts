/**
 * Chat-wire payload and message normalization shared by the Tencent "buddy"
 * family providers — CodeBuddy International (`cb`), CodeBuddy CN (`cbcn`),
 * and WorkBuddy. All three speak the same upstream contract for this part of
 * the payload, so the rules live here once instead of being copied per
 * variant:
 *
 * - streaming is mandatory (`stream=true`);
 * - `reasoning_summary` is opted in only when a `reasoning_effort` is
 *   requested;
 * - the agent-namespace fields are never forwarded;
 * - caller `system`/`developer` turns are replaced by the variant's fixed
 *   leading system prompt, and bare string user content becomes a typed text
 *   block; and
 * - consecutive same-role `user` turns must be merged before dispatch.
 *
 * Provider-specific identity headers and catalog tables stay in each variant's
 * own `*-shared.ts`.
 */
import { completeRequiredSchema } from "../../../protocol/primitives";
import type { CanonicalRequest } from "../../../transport/canonical-model";
import { isRecord } from "../../../protocol/primitives";
import { applyDeepSeekReasoning, applyOpenAIReasoning, backfillDeepSeekReasoningContent } from "../../reasoning";

const BUDDY_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const INVALID_BUDDY_TOOL_NAME_CHARS = /[^a-zA-Z0-9_-]/g;
const MAX_BUDDY_TOOL_NAME_LENGTH = 64;

function uniqueToolName(base: string, used: Set<string>): string {
  const clipped = (base || "tool").slice(0, MAX_BUDDY_TOOL_NAME_LENGTH);
  if (!used.has(clipped)) return clipped;
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `_${suffix}`;
    const candidate = `${clipped.slice(0, MAX_BUDDY_TOOL_NAME_LENGTH - suffixText.length)}${suffixText}`;
    if (!used.has(candidate)) return candidate;
  }
}

function normalizedToolName(value: string, index: number, used: Set<string>): string {
  const base =
    BUDDY_TOOL_NAME_PATTERN.test(value) && value.length <= MAX_BUDDY_TOOL_NAME_LENGTH
      ? value
      : value.replace(INVALID_BUDDY_TOOL_NAME_CHARS, "");
  return uniqueToolName(base || `tool_${index + 1}`, used);
}


export function normalizeBuddyToolNames(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload["tools"])) return;
  const used = new Set<string>();
  const replacements = new Map<string, string>();
  payload["tools"] = payload["tools"].map((rawTool, index) => {
    if (!isRecord(rawTool)) return rawTool;
    const fn = isRecord(rawTool["function"]) ? rawTool["function"] : undefined;
    const custom = isRecord(rawTool["custom"]) ? rawTool["custom"] : undefined;
    const sourceName = fn?.["name"] ?? custom?.["name"] ?? rawTool["name"];
    if (typeof sourceName !== "string") return rawTool;
    const name = normalizedToolName(sourceName, index, used);
    used.add(name);
    if (!replacements.has(sourceName)) replacements.set(sourceName, name);
    if (fn !== undefined)
      return {
        ...rawTool,
        function: {
          ...fn,
          name,
          ...(fn["parameters"] === undefined ? {} : { parameters: completeRequiredSchema(fn["parameters"]) }),
        },
      };
    if (custom !== undefined)
      return {
        ...rawTool,
        custom: {
          ...custom,
          name,
          ...(custom["format"] === undefined ? {} : { format: completeRequiredSchema(custom["format"]) }),
        },
      };
    return {
      ...rawTool,
      name,
      ...(rawTool["parameters"] === undefined ? {} : { parameters: completeRequiredSchema(rawTool["parameters"]) }),
    };
  });
  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message) || !Array.isArray(message["tool_calls"])) continue;
      for (const call of message["tool_calls"]) {
        if (!isRecord(call) || !isRecord(call["function"])) continue;
        const name = call["function"]["name"];
        const replacement = typeof name === "string" ? replacements.get(name) : undefined;
        if (replacement !== undefined) call["function"]["name"] = replacement;
      }
    }
  }
  const choice = payload["tool_choice"];
  if (!isRecord(choice)) return;
  if (choice["type"] === "allowed_tools" && Array.isArray(choice["tools"])) {
    for (const rawAllowed of choice["tools"]) {
      if (!isRecord(rawAllowed)) continue;
      const allowedFn = isRecord(rawAllowed["function"]) ? rawAllowed["function"] : rawAllowed;
      const name = allowedFn["name"];
      const replacement = typeof name === "string" ? replacements.get(name) : undefined;
      if (replacement !== undefined) allowedFn["name"] = replacement;
    }
    return;
  }
  const choiceFn = isRecord(choice["function"]) ? choice["function"] : undefined;
  const choiceCustom = isRecord(choice["custom"]) ? choice["custom"] : undefined;
  const choiceName = choiceFn?.["name"] ?? choiceCustom?.["name"] ?? choice["name"];
  if (typeof choiceName !== "string") return;
  const replacement = replacements.get(choiceName);
  if (replacement === undefined) return;
  if (choiceFn !== undefined) choice["function"] = { ...choiceFn, name: replacement };
  else if (choiceCustom !== undefined) choice["custom"] = { ...choiceCustom, name: replacement };
  else choice["name"] = replacement;
}


/**
 * Payload prefix shared by the buddy pre-payload hooks: force `stream=true`,
 * apply the provider's DeepSeek thinking contract, opt `reasoning_summary` in
 * only when an effort is requested, and drop agent-namespace fields.
 */
export function buddyPrePayloadCommon(
  payload: Record<string, unknown>,
  request?: CanonicalRequest,
): void {
  applyOpenAIReasoning(payload, request);
  applyDeepSeekReasoning(payload);
  payload["stream"] = true;
  const effort = payload["reasoning_effort"];
  if (effort === "none" || effort === "off") {
    delete payload["reasoning_effort"];
    delete payload["reasoning_summary"];
  } else if (typeof effort === "string" && effort.length > 0) {
    payload["reasoning_summary"] = "auto";
  } else {
    delete payload["reasoning_summary"];
  }
  backfillDeepSeekReasoningContent(payload);
  delete payload["agent"];
  delete payload["agent_mode"];
  delete payload["agent_prompt"];
}

/** Normalizes one message's content into a Chat-wire content-part array. */
function contentParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string")
    return content.length === 0 ? [] : [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is Record<string, unknown> => part !== null && typeof part === "object",
  );
}

/**
 * Coalesces consecutive `user` messages into one, preserving content-part
 * order. The buddy upstream merges consecutive same-role turns itself and
 * drops `image_url` parts while doing so, so an attachment delivered as its
 * own user turn (the shape VS Code Copilot emits for a pasted screenshot)
 * reaches the model as text only — the image is silently gone even though the
 * gateway forwarded it. Merging here keeps every image in the same message as
 * the text the caller sent alongside it.
 *
 * Lossless: only adjacent same-role `user` turns merge, and every part is
 * retained in order. Assistant/tool/system turns are untouched.
 */
export function coalesceConsecutiveUserMessages(messages: Array<Record<string, unknown>>): void {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const previous = out[out.length - 1];
    if (message["role"] !== "user" || previous?.["role"] !== "user") {
      out.push(message);
      continue;
    }
    out[out.length - 1] = {
      ...previous,
      content: [...contentParts(previous["content"]), ...contentParts(message["content"])],
    };
  }
  messages.length = 0;
  messages.push(...out);
}

/**
 * Drops messages whose content is empty, mirroring the buddy upstream's own
 * validation (empty-content turns are rejected with code `11151`). Guarded:
 * anything carrying tool calls, tool results, or reasoning is kept — an
 * assistant `tool_calls` turn with null content and a ledger-folded result
 * text are both load-bearing, not empty.
 */
export function dropEmptyBuddyMessages(messages: Array<Record<string, unknown>>): void {
  const kept = messages.filter((message) => {
    if (!isRecord(message)) return true;
    if (Array.isArray(message["tool_calls"]) && message["tool_calls"].length > 0) return true;
    if (typeof message["tool_call_id"] === "string" && message["tool_call_id"].trim().length > 0)
      return true;
    if (typeof message["reasoning_content"] === "string" && message["reasoning_content"].trim().length > 0)
      return true;
    const content = message["content"];
    if (typeof content === "string") return content.trim().length > 0;
    if (Array.isArray(content)) return content.length > 0;
    // Null content with no tool/reasoning load is a bare turn the upstream
    // rejects — drop it rather than dispatch a known-invalid payload.
    return false;
  });
  if (kept.length === messages.length) return;
  messages.length = 0;
  messages.push(...kept);
}

/**
 * Guarantees the wire opens with a `system` turn. The buddy upstream rejects a
 * first message that is not a system prompt (code `11128`), and a CN-neutralized
 * or caller-less history can otherwise arrive with a bare `user` turn first.
 * Non-empty by construction: an empty system turn trips the sibling `11151`
 * validation above, so the placeholder carries real content.
 */
export function ensureBuddyLeadingSystem(
  messages: Array<Record<string, unknown>>,
  systemPrompt: string,
): void {
  if (messages.length === 0) {
    messages.push({ role: "system", content: systemPrompt });
    return;
  }
  const first = messages[0];
  if (isRecord(first) && first["role"] === "system") return;
  messages.unshift({ role: "system", content: systemPrompt });
}

/**
 * Runs the full buddy message-envelope tail shared by every variant: merge
 * consecutive user turns, drop empty-content turns the upstream rejects
 * (`11151`), then guarantee a leading system turn (`11128`). The system text
 * is the variant's own prompt, so each pre-payload hook passes its prompt in.
 */
export function finalizeBuddyMessages(
  messages: Array<Record<string, unknown>>,
  systemPrompt: string,
): void {
  coalesceConsecutiveUserMessages(messages);
  dropEmptyBuddyMessages(messages);
  ensureBuddyLeadingSystem(messages, systemPrompt);
}

/**
 * Applies the buddy-family message envelope in place: drop caller
 * `system`/`developer` turns, install the variant's fixed leading system
 * prompt, rebuild bare string user content as a typed text block, then
 * coalesce consecutive user turns.
 *
 * The upstream gateway expects that fixed leading prompt and rejects bare
 * string user content, so every variant that has one applies the same
 * transformation — only the prompt text differs, which is why the caller
 * passes it in. Variants without a fixed prompt (CodeBuddy CN replaces caller
 * system text with a neutralizer instead) keep their own path and share only
 * `coalesceConsecutiveUserMessages`.
 *
 * Tool call/output pairing is intentionally NOT handled here: the shared
 * canonical repair (`repairRequestToolCalls`, request/preparer) owns it for
 * every route, so this stays a system-prompt and content-shape hook.
 */
export function applyBuddySystemPrompt(
  messages: Array<Record<string, unknown>>,
  systemPrompt: string,
): void {
  const source = messages.filter(
    (message) => message["role"] !== "system" && message["role"] !== "developer",
  );
  messages.length = 0;
  messages.push({ role: "system", content: systemPrompt });
  for (const message of source) {
    if (message["role"] === "user" && typeof message["content"] === "string") {
      messages.push({
        ...message,
        content: [{ type: "text", text: message["content"] }],
      });
    } else {
      messages.push({ ...message });
    }
  }
  finalizeBuddyMessages(messages, systemPrompt);
}
