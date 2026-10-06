/** Accumulated arguments + pinned index for one in-progress tool call. */
export interface ToolCallState {
  id: string;
  name?: string;
  arguments: string;
  index: number;
}

/**
 * Per-state argument fragments. `ToolCallState.arguments` stays a plain
 * string field for readers, but the tracker accumulates fragments here and
 * joins once per read instead of re-copying the whole prefix on every
 * delta (which is O(n²) for large tool arguments).
 */
const argumentChunks = new WeakMap<ToolCallState, string[]>();

/**
 * Single tool-call tracking home: id/index/arguments-accumulation keyed by
 * call id with index fallback. Shared by the chat surface (explicit wire
 * indexes) and the Messages ledger (ledger-global indexes via
 * `fallbackIndex`) so every encoder agrees on index pinning instead of
 * reimplementing the same maps.
 */
export interface ToolCallTracker {
  readonly indexById: Map<string, number>;
  readonly states: Map<string, ToolCallState>;
  nextIndex: number;
}

export function createToolCallTracker(): ToolCallTracker {
  return { indexById: new Map(), states: new Map(), nextIndex: 0 };
}

/** Clears all tracked calls and resets index assignment (per-turn reset). */
export function resetToolCallTracker(tracker: ToolCallTracker): void {
  tracker.indexById.clear();
  tracker.states.clear();
  tracker.nextIndex = 0;
}

/**
 * Pins a stable per-tool index and accumulates streamed `arguments`.
 * Index precedence: explicit non-negative wire index, then the pinned index
 * for a known id, then `fallbackIndex` (callers sharing one counter across
 * tool and non-tool blocks, e.g. the Messages ledger), then the tracker's
 * own counter. Names are sticky (first defined wins); `isFirst` marks the
 * first sighting of an id.
 */
export function trackToolCall(
  tracker: ToolCallTracker,
  tool: { id: string; name?: string | undefined; args?: string | undefined; index?: number | undefined },
  fallbackIndex?: number,
): { index: number; isFirst: boolean; state: ToolCallState } {
  const priorIndex = tracker.indexById.get(tool.id);
  const index =
    tool.index !== undefined && Number.isInteger(tool.index) && tool.index >= 0
      ? tool.index
      : (priorIndex ?? fallbackIndex ?? tracker.nextIndex++);
  tracker.indexById.set(tool.id, index);
  tracker.nextIndex = Math.max(tracker.nextIndex, index + 1);
  const prior = tracker.states.get(tool.id);
  const name = tool.name ?? prior?.name;
  // Append the fragment in O(1) amortized; the joined snapshot is produced
  // lazily by the `arguments` getter below, so N deltas cost O(N) total
  // instead of O(N²) prefix re-copies. The chunk array is shared forward
  // along one call id (superseded states are never read after replacement).
  const chunks =
    prior !== undefined ? (argumentChunks.get(prior) ?? [prior.arguments]) : [];
  chunks.push(tool.args ?? "");
  const state: ToolCallState = {
    id: tool.id || prior?.id || "",
    get arguments() {
      return chunks.join("");
    },
    index,
  };
  argumentChunks.set(state, chunks);
  if (name !== undefined) state.name = name;
  tracker.states.set(tool.id, state);
  return { index, isFirst: prior === undefined, state };
}

// ===== Emission ledger =====

/**
 * Collapses provider-specific duplicate spellings of one logical call id.
 * Some backends deliver a single call under two ids that differ only by
 * prefix (`call_<suffix>` vs `fc_<suffix>`); both must resolve to one call so
 * an agent does not perform the same action twice. This is the ONLY place
 * that prefix is interpreted.
 */
export function toolIdentityKey(callId: string): string {
  return callId.replace(/^(?:call|fc)_/, "");
}

interface LedgerEntry {
  name?: string;
  arguments?: string;
  streamedArguments: boolean;
}

/**
 * Per-stream tool-call emission ledger: one entry per logical call.
 *
 * `claimFirstEmission` is the single gate for call-defining events, so a
 * duplicate reaches the client zero times by construction instead of being
 * filtered after the fact by independently maintained per-path sets.
 */
export interface ToolEmitLedger {
  /** True when this call has not been defined yet; marks it seen. */
  claimFirstEmission(callId: string, name?: string, args?: string): boolean;
  /** True when this call already streamed at least one arguments delta. */
  hasStreamedArguments(callId: string): boolean;
  /**
   * True when a different call already claimed the same name + arguments.
   *
   * Only *substantive* arguments count as evidence of duplication. A call whose
   * arguments are still empty is indistinguishable from any other call to the
   * same tool, so collapsing on that basis suppresses the second of two
   * legitimate parallel calls — and with it the call's name, which the client
   * then replays upstream as `name: ""` (the Muse
   * `` `name` must be non-empty `` failure).
   */
  isDuplicateDefinition(callId: string, name: string, args: string): boolean;
  markStreamedArguments(callId: string): void;
  /** Unique id for an item carrying no identity, so parallel calls never merge. */
  nextOrphanId(prefix: string): string;
  reset(): void;
}

/** One entry per tool call in one response; the ledger dies with the stream. */
export function createToolEmitLedger(): ToolEmitLedger {
  // Keyed by identity key, so a differently-prefixed id for an already
  // claimed call resolves to the same entry without a scan.
  const entries = new Map<string, LedgerEntry>();
  let orphanSeq = 0;

  return {
    claimFirstEmission(callId: string, name?: string, args?: string): boolean {
      const key = toolIdentityKey(callId);
      if (entries.has(key)) return false;
      entries.set(key, {
        streamedArguments: false,
        ...(name === undefined ? {} : { name }),
        ...(args === undefined ? {} : { arguments: args }),
      });
      return true;
    },
    hasStreamedArguments(callId: string): boolean {
      return entries.get(toolIdentityKey(callId))?.streamedArguments === true;
    },
    /**
     * True when a *different* logical call already claimed the same name and
     * arguments — a backend delivering one call under two ids. Same-id
     * repeats are continuations, never duplicates.
     */
    isDuplicateDefinition(callId: string, name: string, args: string): boolean {
      // An empty argument list carries no identity: two parallel calls to the
      // same tool both start at `arguments: ""`, and treating that as a
      // duplicate drops the second call's name. The client then stores
      // `function.name: ""` in its transcript and every later request is
      // rejected upstream with "`name` must be non-empty".
      if (args.trim().length === 0) return false;
      // Known Codex/Responses spellings are normalized by toolIdentityKey.
      // Name+arguments fallback is only for unknown provider prefixes; applying
      // it to known ids would suppress two legitimate identical parallel calls.
      if (/^(?:call|fc)_/.test(callId)) return false;
      const key = toolIdentityKey(callId);
      for (const [id, entry] of entries) {
        if (id === key) continue;
        if (entry.name === name && entry.arguments === args) return true;
      }
      return false;
    },
    markStreamedArguments(callId: string): void {
      // Creates the entry when the delta arrives before any defining frame,
      // so the terminal frame cannot re-emit the full `arguments`.
      const key = toolIdentityKey(callId);
      const entry = entries.get(key);
      if (entry !== undefined) entry.streamedArguments = true;
      else entries.set(key, { streamedArguments: true });
    },
    nextOrphanId(prefix: string): string {
      orphanSeq += 1;
      return `${prefix}-orphan-${orphanSeq}`;
    },
    reset(): void {
      entries.clear();
    },
  };
}
