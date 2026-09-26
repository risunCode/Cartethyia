// Tool-use auto-repair: strict providers (Anthropic, Gemini) reject conversation
// histories where an assistant `toolCall` is never answered by a matching
// `toolResult`. Repairing here — after the variant plan loop has derived the
// winning route's capabilities and before projection — keeps the request
// dispatchable instead of failing upstream with a 400 the client cannot fix.

import type { CanonicalMessage, CanonicalRequest } from "../canonical-model";
import { canContainToolResult } from "../canonical-model";

const MISSING_TOOL_OUTPUT = "<missing tool output>";

/** True when any tool/user turn carries a `toolResult` part for `callId`. */
function findToolResult(
  turns: readonly CanonicalMessage[],
  callId: string,
): boolean {
  return turns.some(
    (turn) =>
      canContainToolResult(turn) &&
      turn.content.some((part) => part.kind === "toolResult" && part.call_id === callId),
  );
}

/**
 * Returns a copy of `messages` where every assistant `toolCall` that lacks a
 * subsequent matching `toolResult` is immediately followed by a synthetic
 * tool message with non-empty content. Multiple unmatched calls inside the
 * same assistant message each get their own synthetic result, in call order —
 * so a partial batch `assistant[c1 c2] + tool[c1]` synthesizes only `c2`, and
 * the wire keeps the call-declared order (`tool[c2-synth]` before the
 * pre-existing `tool[c1]`).
 *
 * Matching is positional, never by bare id: a result answers only calls in
 * EARLIER messages, never the message it sits in or a later one. Otherwise a
 * result that precedes its call (client replayed a stale turn first) would
 * satisfy that call — and worse, a result for batch N would silence a
 * same-id call the client reuses in batch N+1.
 */
export function repairMissingToolResponses(
  messages: readonly CanonicalMessage[],
): CanonicalMessage[] {
  const repaired: CanonicalMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as CanonicalMessage;
    repaired.push(message);
    if (message.role !== "assistant") continue;
    const callIds = message.content
      .filter((part) => part.kind === "toolCall")
      .map((part) => (part as Extract<typeof part, { kind: "toolCall" }>).call_id);
    if (callIds.length === 0) continue;

    // Answered = a later tool message carrying a matching toolResult part.
    const later = messages.slice(index + 1);
    const orphanIds = callIds.filter((id) => !findToolResult(later, id));
    if (orphanIds.length === 0) continue;

    for (const callId of orphanIds) {
      repaired.push({
        role: "tool",
        // Labeled as an error, never as real tool output: the model must
        // see an interrupted tool, not fabricated success content.
        content: [{ kind: "toolResult", call_id: callId, content: MISSING_TOOL_OUTPUT, is_error: true }],
      });
    }
  }
  return repaired;
}
/**
 * Drops incomplete tool rounds: an assistant message whose `tool_calls` are not
 * fully answered by matching `tool` results is stripped of its calls (kept when
 * it still carries content), and the dangling results go with it.
 *
 * This is the buddy-family policy (WorkBuddy/CodeBuddy code `11148`): a partial
 * batch `assistant[c1 c2] + tool[c1]` is a broken sequence the upstream rejects,
 * and a synthesized placeholder cannot stand in for a real execution the model
 * never saw. Contrast `repairMissingToolResponses`, which synthesizes an
 * error-labeled result so the model sees an interrupted tool — that policy
 * serves strict Anthropic/Gemini wires, not the buddy gateway.
 *
 * Only rounds fully contained in the history are judged: calls whose results
 * arrive later in the same array still count, and an assistant batch at the
 * array end with no results yet is left for the next turn's synthesis pass.
 */
export function dropIncompleteToolRounds(
  messages: readonly CanonicalMessage[],
): CanonicalMessage[] {
  let changed = false;
  const out: CanonicalMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index] as CanonicalMessage;
    if (message.role !== "assistant" || toolCallIdsIn(message).length === 0) {
      out.push(message);
      index += 1;
      continue;
    }
    const want = new Set(toolCallIdsIn(message));
    const results: CanonicalMessage[] = [];
    let cursor = index + 1;
    while (cursor < messages.length) {
      const next = messages[cursor] as CanonicalMessage;
      // Answers live in `tool` turns OR in `user` turns: the Messages ledger
      // re-homes every Anthropic tool flow into `user` turns. A `role: "tool"`
      // check alone read a *complete* round as incomplete, stripped the tool
      // calls, and left the dangling result behind — a broken sequence the
      // buddy gateway rejects (`11148`).
      if (!canContainToolResult(next)) break;
      const answered = next.content.some(
        (part) => part.kind === "toolResult" && want.has(part.call_id),
      );
      if (!answered) break;
      results.push(next);
      cursor += 1;
    }
    const answeredIds = new Set<string>();
    for (const result of results) {
      for (const part of result.content) {
        if (part.kind === "toolResult" && want.has(part.call_id)) answeredIds.add(part.call_id);
      }
    }
    const complete = want.size > 0 && answeredIds.size === want.size;
    if (!complete && results.length === 0 && cursor >= messages.length) {
      // Trailing batch with no results yet: not incomplete, just unfinished.
      out.push(message);
      index += 1;
      continue;
    }
    if (complete) {
      out.push(message, ...results);
      index = cursor;
      continue;
    }
    changed = true;
    // Strip the calls; keep the turn when it still says something.
    const keptContent = message.content.filter((part) => part.kind !== "toolCall");
    if (keptContent.length > 0) out.push({ ...message, content: keptContent });
    index = cursor > index + 1 ? cursor : index + 1;
  }
  return changed ? out : [...messages];
}
/**
 * Repairs orphan tool calls on a canonical request when the target route maps
 * to a strict wire family (`messages` → Anthropic, Gemini). The check is
 * conservative: the repair is a structural no-op for compliant histories, so
 * applying it broadly is safe.
 */
export function repairRequestToolCalls(request: CanonicalRequest): CanonicalRequest {
  // Order matters. Orphans are dropped first so a synthesized result is never
  // created for a call the client already lost, then missing results are
  // filled (forward scan so a synthesized result never satisfies an EARLIER
  // call that also lacks one), then results are made contiguous — repacking
  // last so it sees the final set of results rather than a batch that is
  // about to change.
  let messages = dropOrphanToolResults(request.messages);
  messages = repairMissingToolResponses(messages);
  messages = repackToolResultBlocks(messages);
  if (messages.length === request.messages.length) {
    // Same length can still mean reordered or content-edited turns; compare
    // identity so a pure reorder is not dropped on the floor.
    const unchanged = messages.every((message, index) => message === request.messages[index]);
    if (unchanged) return request;
  }
  return { ...request, messages };
}

/**
 * True when a `toolResult` part is a `tool`-role turn whose `toolCall` is
 * absent from the whole history, or when results for one batch of calls are
 * not contiguous. Upstreams reject both with `tool_call_sequence_broken`
 * (WorkBuddy/CodeBuddy code `11148`), and a broken history stays broken: the
 * client replays it on every later turn, so the whole conversation dies.
 */
function toolCallIdsIn(message: CanonicalMessage): string[] {
  return message.content
    .filter((part) => part.kind === "toolCall")
    .map((part) => (part as Extract<typeof part, { kind: "toolCall" }>).call_id);
}

/**
 * Removes `toolResult` parts whose `toolCall` is missing anywhere in the
 * history.
 *
 * OpenAI-compatible wires require every `role: "tool"` message to answer a
 * preceding `tool_calls` entry. A client whose tool execution failed often
 * persists the result but not the call (or vice versa), and that orphan then
 * poisons every subsequent request. Dropping the orphan loses one round of
 * tool context; keeping it loses the conversation.
 *
 * Only results are dropped here. A call without a result is a different shape
 * and is repaired by synthesizing a result (`repairMissingToolResponses`), not
 * by deleting the call — the model should see that the tool was interrupted.
 */
export function dropOrphanToolResults(
  messages: readonly CanonicalMessage[],
): CanonicalMessage[] {
  const callIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const id of toolCallIdsIn(message)) callIds.add(id);
  }
  let changed = false;
  const out: CanonicalMessage[] = [];
  for (const message of messages) {
    // Answers live in `tool` turns OR in `user` turns (the Messages ledger
    // re-homes every Anthropic tool flow there), so the orphan scan must use
    // the shared `canContainToolResult` rule. Checking only `role: "tool"`
    // left an orphan result in a user turn untouched; `chat.ts` then emitted
    // it as `role:"tool"` with no matching `tool_calls`, and the upstream
    // rejected the entire history — the exact
    // "tool calls and tool results do not match" 400 that kills a
    // conversation permanently, since the client replays it every turn.
    if (!canContainToolResult(message)) {
      out.push(message);
      continue;
    }
    const kept = message.content.filter(
      (part) => part.kind !== "toolResult" || callIds.has(part.call_id),
    );
    if (kept.length === message.content.length) {
      out.push(message);
      continue;
    }
    changed = true;
    // A turn that carried only orphan results has nothing left to say.
    if (kept.length > 0) out.push({ ...message, content: kept });
  }
  return changed ? out : [...messages];
}

/**
 * Moves non-`tool` turns that were interleaved into one batch of tool results
 * to after the batch, so results stay contiguous.
 *
 * Codex's `image_resize_notice` arrives as a `developer` turn and lands between
 * two parallel tool results:
 *
 *   assistant tool_calls=[c1 c2] | tool c1 | developer <notice> | tool c2
 *
 * OpenAI-compatible wires read any message between a call and its result as a
 * broken sequence (`11148`). Reordering only — the relative order of the
 * results themselves, and every message's content, is unchanged.
 */
export function repackToolResultBlocks(
  messages: readonly CanonicalMessage[],
): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  let index = 0;
  let changed = false;
  while (index < messages.length) {
    const message = messages[index] as CanonicalMessage;
    const callIds = message.role === "assistant" ? toolCallIdsIn(message) : [];
    if (callIds.length === 0) {
      out.push(message);
      index += 1;
      continue;
    }
    const want = new Set(callIds);
    out.push(message);
    index += 1;
    const results: CanonicalMessage[] = [];
    const between: CanonicalMessage[] = [];
    let sawNonTool = false;
    while (index < messages.length) {
      const next = messages[index] as CanonicalMessage;
      // Same canonical rule as everywhere else: an answer may live in a
      // `tool` turn or in a `user` turn (Messages re-homes results there).
      if (canContainToolResult(next)) {
        const answered = next.content.some(
          (part) => part.kind === "toolResult" && want.has(part.call_id),
        );
        if (!answered) break;
        results.push(next);
        if (sawNonTool) changed = true;
        index += 1;
        continue;
      }
      // A following assistant turn that starts its own batch is the next group
      // header; swallowing it here would strand its own results.
      if (next.role === "assistant" && toolCallIdsIn(next).length > 0) break;
      if (results.length === 0) break;
      between.push(next);
      sawNonTool = true;
      index += 1;
    }
    out.push(...results, ...between);
  }
  return changed ? out : [...messages];
}
