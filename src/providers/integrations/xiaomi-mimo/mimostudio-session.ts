import { createHash, randomUUID } from "node:crypto";
import type { CanonicalRequest, ContentPart } from "../../../protocol/canonical-model";
import type { ProviderDispatchContext } from "../../contracts";
import { resolveInboundSessionId } from "../../operations/session-resolution";

/**
 * `conversationId` in the Studio bot-chat body selects which upstream chat the
 * turn continues, and the upstream keeps that chat's history server-side.
 * Minting a fresh id per dispatch made every turn a brand-new upstream
 * conversation, so a follow-up lost the thread and concurrent callers sharing
 * one provider account were indistinguishable.
 *
 * This store remembers one conversation per client chat, keyed by provider
 * account plus the inbound session identity, so a chat stays on its own thread
 * while other chats keep theirs. It also tracks which turns the upstream has
 * actually received, which is what lets a dispatch send only the new ones — the
 * bot endpoint rejects a `query` above ~50k characters, so replaying a long
 * history is what breaks a large context even though the model advertises a far
 * bigger window.
 *
 * What is recorded is the turns the upstream *received*, not the turns the
 * client sent: a query too long for the endpoint has its oldest turns dropped,
 * and those turns are not in the upstream conversation.
 */

/** Distinct conversations remembered per provider account. */
const MAX_TRACKED_SESSIONS = 256;
/** Idle conversations are forgotten; a pasted Studio cookie outlives none of them. */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * Turns remembered per conversation. Past this the window keeps the newest
 * turns, because the newest end is what the next dispatch resumes from.
 */
const MAX_SIGNATURE_TURNS = 512;
/** Separates account and session in a store key; no id may contain it. */
const KEY_SEPARATOR = "\u0000";

interface TrackedConversation {
  conversationId: string;
  /** Index of the first stored turn within the request that produced it. */
  start: number;
  /** One entry per turn the upstream has received, oldest first. */
  signatures: readonly string[];
  lastUsedAt: number;
}

/** The conversation a request continues, and how much of it is already upstream. */
export interface MimoStudioConversation {
  readonly conversationId: string;
  /** Leading non-system turns the upstream already holds and need not be resent. */
  readonly skipTurns: number;
  /** Index of the first turn the upstream holds, within this request. */
  readonly knownStart: number;
  /** Store key, passed back to {@link MimoStudioSessionStore.commit}. */
  readonly key: string;
}

/**
 * Per-turn signature covering text and tool parts.
 *
 * One entry per turn — not per text block — so a stored range maps directly
 * onto turn indices. Reasoning parts are excluded: a client may drop provider
 * thinking when it replays history, and that must not read as a divergence.
 * Hashed so a long chat costs a fixed amount per turn instead of retaining the
 * prompt text.
 */
function turnSignature(message: CanonicalRequest["messages"][number]): string {
  const parts: string[] = [message.role];
  for (const part of message.content) {
    if (part.kind === "text") parts.push(`t:${part.text.trim()}`);
    else if (part.kind === "toolCall") parts.push(`c:${part.name}:${JSON.stringify(part.arguments)}`);
    else if (part.kind === "toolResult") {
      const content: readonly ContentPart[] | string = part.content;
      parts.push(`r:${typeof content === "string" ? content : JSON.stringify(content)}`);
    }
  }
  return createHash("sha256").update(parts.join(KEY_SEPARATOR)).digest("hex");
}

function turnSignatures(request: CanonicalRequest): string[] {
  const signatures: string[] = [];
  for (const message of request.messages) {
    if (message.role === "system") continue;
    signatures.push(turnSignature(message));
  }
  return signatures;
}

/**
 * True when the stored range still lines up with `current` and leaves at least
 * one turn after it, i.e. the request continues the conversation rather than
 * restating it or diverging from it.
 */
function matchesStoredRange(current: readonly string[], tracked: TrackedConversation): boolean {
  const end = tracked.start + tracked.signatures.length;
  if (end >= current.length) return false;
  for (let index = 0; index < tracked.signatures.length; index++) {
    if (current[tracked.start + index] !== tracked.signatures[index]) return false;
  }
  return true;
}

/** In-process conversation affinity for one MiMo Studio adapter instance. */
export class MimoStudioSessionStore {
  #sessions = new Map<string, TrackedConversation>();

  /**
   * Resolves the conversation this request must continue and how much of it the
   * upstream already holds.
   *
   * An explicit client session id pins its conversation outright, because a
   * client that owns the session may send only the newest turn. Without one,
   * only a stored range anchored at the start of the request may reuse a
   * conversation, so unrelated chats on the same account never land in one
   * thread.
   *
   * Nothing is recorded until {@link commit}, because how many turns the
   * upstream actually receives is only known once the request body is built.
   */
  resolve(request: CanonicalRequest, context: ProviderDispatchContext, now: number): MimoStudioConversation {
    this.#evict(now);
    const accountId = context.credential.account_id ?? context.credential.provider_id;
    const signatures = turnSignatures(request);
    const sessionId = resolveInboundSessionId(context, request);

    if (sessionId) {
      const key = `${accountId}${KEY_SEPARATOR}${sessionId}`;
      const pinned = this.#sessions.get(key);
      if (pinned) {
        pinned.lastUsedAt = now;
        this.#touch(key, pinned);
        if (matchesStoredRange(signatures, pinned)) {
          return {
            conversationId: pinned.conversationId,
            skipTurns: pinned.start + pinned.signatures.length,
            knownStart: pinned.start,
            key,
          };
        }
        // The client sent a delta the store cannot line up, or restated the
        // conversation; send what it gave and let the upstream decide.
        return { conversationId: pinned.conversationId, skipTurns: 0, knownStart: 0, key };
      }
      return { conversationId: this.#mint(), skipTurns: 0, knownStart: 0, key };
    }

    const accountPrefix = `${accountId}${KEY_SEPARATOR}`;
    for (const [key, tracked] of [...this.#sessions].reverse()) {
      if (!key.startsWith(accountPrefix)) continue;
      if (tracked.start !== 0) continue;
      if (!matchesStoredRange(signatures, tracked)) continue;
      tracked.lastUsedAt = now;
      this.#touch(key, tracked);
      return {
        conversationId: tracked.conversationId,
        skipTurns: tracked.signatures.length,
        knownStart: 0,
        key,
      };
    }

    return { conversationId: this.#mint(), skipTurns: 0, knownStart: 0, key: `${accountPrefix}${randomUUID()}` };
  }

  /**
   * Records the turns the upstream received.
   *
   * `forwardedStart` is the index of the first forwarded turn within the turns
   * the request asked to send, and `forwardedTurns` how many followed it. A
   * query trimmed to fit the endpoint's limit therefore records the trimmed
   * range, not context the upstream never received.
   */
  commit(
    request: CanonicalRequest,
    conversation: MimoStudioConversation,
    forwardedStart: number,
    forwardedTurns: number,
    now: number,
  ): void {
    if (forwardedTurns <= 0) return;
    const current = turnSignatures(request);
    const end = Math.min(conversation.skipTurns + forwardedStart + forwardedTurns, current.length);
    // A resumed conversation keeps the range it already had; a fresh one starts
    // at the first forwarded turn.
    const start =
      conversation.skipTurns > 0 ? conversation.knownStart : conversation.skipTurns + forwardedStart;
    if (end <= start) return;

    let signatures = current.slice(start, end);
    let rangeStart = start;
    if (signatures.length > MAX_SIGNATURE_TURNS) {
      rangeStart += signatures.length - MAX_SIGNATURE_TURNS;
      signatures = signatures.slice(-MAX_SIGNATURE_TURNS);
    }

    const existing = this.#sessions.get(conversation.key);
    // Never move backwards: a shorter request must not erase what a fuller one
    // already established.
    if (existing !== undefined && existing.start + existing.signatures.length >= rangeStart + signatures.length) {
      existing.lastUsedAt = now;
      this.#touch(conversation.key, existing);
      return;
    }

    this.#touch(conversation.key, {
      conversationId: conversation.conversationId,
      start: rangeStart,
      signatures,
      lastUsedAt: now,
    });
  }

  #mint(): string {
    return `conv_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  }

  /** Re-inserts on use so the map stays ordered least- to most-recently used. */
  #touch(key: string, tracked: TrackedConversation): void {
    this.#sessions.delete(key);
    this.#sessions.set(key, tracked);
  }

  #evict(now: number): void {
    for (const [key, tracked] of this.#sessions) {
      if (now - tracked.lastUsedAt <= SESSION_TTL_MS) break;
      this.#sessions.delete(key);
    }
    while (this.#sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.#sessions.keys().next();
      if (oldest.done) return;
      this.#sessions.delete(oldest.value);
    }
  }
}
