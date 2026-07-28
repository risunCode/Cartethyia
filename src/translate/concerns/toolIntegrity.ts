/**
 * Anthropic-upstream tool call integrity — two request-shape requirements
 * Anthropic enforces server-side that OpenAI does not, so the OpenAI-shape
 * request that got us here can violate both without ever being invalid on
 * its own terms:
 *
 *  1. Every `tool_use` block in an assistant turn MUST be answered by a
 *     matching `tool_result` in the immediately following turn — a client
 *     that sends a hand-edited or truncated history (common in agentic
 *     loops that crop old turns) can omit one, and Anthropic responds with
 *     a 400 for the ENTIRE request, not just a warning.
 *  2. `tool_use.id` (and the `tool_result.tool_use_id` that references it)
 *     MUST match `^[a-zA-Z0-9_-]+$` — an id minted by a different
 *     OpenAI-compatible upstream can contain characters outside that set
 *     (e.g. `+`/`/`/`=` from a base64 id), which Anthropic also rejects
 *     with a 400.
 *
 * Both run on `UnifiedMessage[]` right after normalize, before the cache
 * breakpoint pass, so caching operates on the message set that will
 * actually be sent.
 */

import { isToolCallBlock, isToolResultBlock } from "./blocks";
import type { UnifiedBlock, UnifiedMessage } from "./blocks";

const ANTHROPIC_TOOL_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Inserts an empty `tool_result` for any `tool_call` left unanswered by the
 * next message, so the request passes Anthropic's "every tool_use needs a
 * tool_result" validation instead of getting rejected outright. An empty
 * result is a deliberate signal to the model ("this tool produced nothing")
 * rather than lying about success.
 *
 * The synthetic result is MERGED into the front of the next message's
 * blocks whenever that next message already maps to Anthropic's "user"
 * role (every UnifiedRole except "assistant" — see denormalizeToAnthropic-
 * Messages), rather than inserted as a standalone message: two consecutive
 * user-role turns is itself an Anthropic 400 ("roles must alternate"),
 * which would just trade one crash for another. A standalone message is
 * only safe right before an "assistant" turn or at the very end.
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
      pendingPrefixBlocks = syntheticBlocks; // merged into `next` on its own loop iteration, above
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
 * replacement — sanitizing only the call side (as a naive per-block
 * transform would) breaks the correlation Anthropic uses to match a result
 * back to its call, turning a fixable id into an orphaned reference.
 */
export function sanitizeAnthropicToolIds(messages: UnifiedMessage[]): UnifiedMessage[] {
  const remap = new Map<string, string>();
  // Pre-populate with every id that's ALREADY valid so a generated
  // replacement can never collide with an untouched id elsewhere in the
  // same request.
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
