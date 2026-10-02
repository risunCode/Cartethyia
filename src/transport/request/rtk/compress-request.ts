/**
 * Request compression applied to the canonical request before dispatch.
 *
 * Two independent transforms, both off by default and toggled per tenant
 * (`ConsoleSettingsPreferences`):
 *
 *  - **RTK prune** — compacts bulky `toolResult` text (a diff, a grep dump, a
 *    directory listing) into a shorter, still-faithful form, so a long agent
 *    conversation does not re-send megabytes of raw tool output every turn.
 *    Strength is selectable (`lite`/`full`/`ultra`, see `RTK_PROFILES`): higher
 *    levels lower the size gate, enable the content-agnostic fallbacks, and run
 *    a second generic pass — more shrink, more risk to fidelity.
 *  - **PonyTail** — appends a minimal-code directive to the system content.
 *
 * Both operate on the *canonical* request, not a wire body: the surface codecs
 * have already normalized `system`/`messages`/content parts into one shape, so
 * the same transform covers every wire (chat, responses, messages) and every
 * provider without per-wire surgery.
 *
 * RTK never touches a blob below the level's size gate or pathologically large
 * (`RTK_RAW_CAP`), never rewrites a non-text part, and never grows a result —
 * `safeApplyFilter` guarantees the last two.
 */
import type { CanonicalMessage, CanonicalRequest, ContentPart } from "../../canonical-model";
import { autoDetectFilter, dedupLogFilter, safeApplyFilter, smartTruncateFilter } from "./rtk-filters";
import { RTK_RAW_CAP, rtkProfile, type RtkLevel } from "./rtk-constants";
import { ponyTailPrompt, type PonyTailLevel } from "./ponytail-prompt";

export interface CompressionOptions {
  /** Compact bulky tool-result text in the message history. */
  readonly rtkPrune?: boolean;
  /** RTK strength; `full` when omitted. See {@link RtkLevel}. */
  readonly rtkLevel?: RtkLevel | null | undefined;
  /** Append a PonyTail directive to the system content, at this level. */
  readonly ponyTail?: PonyTailLevel | null | undefined;
}

export interface CompressionStats {
  /** Tool-result text parts actually shortened. */
  readonly prunedParts: number;
  /** Characters removed by RTK (>= 0). */
  readonly savedChars: number;
  /** Whether a PonyTail directive was appended. */
  readonly ponyTailInjected: boolean;
}

/** Compresses one text blob with RTK at a strength level, or returns it unchanged. */
export function compressToolText(text: string, level?: RtkLevel | null): string {
  const profile = rtkProfile(level);
  if (text.length < profile.minSize || text.length > RTK_RAW_CAP) return text;
  const filter = autoDetectFilter(text, { genericFallback: profile.genericFallback });
  if (!filter) return text;
  let out = safeApplyFilter(filter, text);
  // `ultra` squeezes once more with the generic filters: a structural filter
  // (say grep) can still leave a long tail of repeated lines, and the second
  // pass compacts that. `safeApplyFilter` keeps the no-grow guarantee, so the
  // second pass can only shorten further, never expand.
  if (profile.secondPass && out.length < text.length) {
    const second = safeApplyFilter(dedupLogFilter, out);
    out = safeApplyFilter(smartTruncateFilter, second);
  }
  return out;
}

/** Returns the RTK-compressed copy of a tool-result content list, plus chars saved. */
function compressToolResultContent(
  content: readonly ContentPart[] | string,
  level: RtkLevel | null,
): { readonly content: readonly ContentPart[] | string; readonly savedChars: number; readonly parts: number } {
  if (typeof content === "string") {
    const next = compressToolText(content, level);
    return { content: next, savedChars: content.length - next.length, parts: next === content ? 0 : 1 };
  }
  let savedChars = 0;
  let parts = 0;
  const next = content.map((part) => {
    if (part.kind !== "text") return part;
    const compressed = compressToolText(part.text, level);
    if (compressed === part.text) return part;
    savedChars += part.text.length - compressed.length;
    parts += 1;
    return { ...part, text: compressed };
  });
  return { content: next, savedChars, parts };
}

function pruneMessages(
  messages: readonly CanonicalMessage[],
  level: RtkLevel | null,
): {
  readonly messages: readonly CanonicalMessage[];
  readonly savedChars: number;
  readonly parts: number;
} {
  let savedChars = 0;
  let parts = 0;
  let changed = false;
  const next = messages.map((message) => {
    if (!message.content.some((part) => part.kind === "toolResult")) return message;
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part.kind !== "toolResult" || part.is_error === true) return part;
      const result = compressToolResultContent(part.content, level);
      if (result.parts === 0) return part;
      savedChars += result.savedChars;
      parts += result.parts;
      messageChanged = true;
      return { ...part, content: result.content };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return { messages: changed ? next : messages, savedChars, parts };
}

/** Appends a PonyTail directive to the system content, idempotently. */
function injectPonyTail(
  request: CanonicalRequest,
  prompt: string,
): CanonicalRequest {
  const system = request.system ?? [];
  if (system.some((part) => part.kind === "text" && part.text === prompt)) return request;
  return { ...request, system: [...system, { kind: "text", text: prompt }] };
}

/**
 * Applies the enabled compression transforms to a canonical request. Returns the
 * same request object when nothing changed, so callers can compare by identity.
 */
export function compressRequest(
  request: CanonicalRequest,
  options: CompressionOptions,
): { readonly request: CanonicalRequest; readonly stats: CompressionStats } {
  let next = request;
  let savedChars = 0;
  let prunedParts = 0;

  if (options.rtkPrune) {
    const pruned = pruneMessages(next.messages, options.rtkLevel ?? null);
    if (pruned.parts > 0) {
      next = { ...next, messages: pruned.messages };
      savedChars = pruned.savedChars;
      prunedParts = pruned.parts;
    }
  }

  let ponyTailInjected = false;
  if (options.ponyTail) {
    const withPrompt = injectPonyTail(next, ponyTailPrompt(options.ponyTail));
    ponyTailInjected = withPrompt !== next;
    next = withPrompt;
  }

  return {
    request: next,
    stats: { prunedParts, savedChars, ponyTailInjected },
  };
}
