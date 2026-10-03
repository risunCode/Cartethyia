/**
 * Dashboard-side view of the per-model reasoning ladder.
 *
 * The pickers must answer one question — "which levels will this model actually
 * honor?" — and the only trustworthy answer is the one dispatch itself uses.
 * `resolveSupportedReasoningEfforts` in `src/transport/translation/thinking` is
 * the single source of that truth (it backs the Chat, Messages and Responses
 * codecs *and* the probe gate), so this module calls it rather than re-deriving
 * a ladder. A hand-rolled copy would disagree with the router the first time a
 * model is added, which is exactly the bug these pickers exist to avoid.
 *
 * Two wrinkles the raw resolver does not cover:
 *
 * - It is keyed on `modelId` + `wireFamily`, not on the catalog's
 *   `reasoning: boolean`. A row whose `reasoning` flag is false (the `gpt-4o`
 *   family, qoder's `auto`) has no effort ladder at all, so it is reported as
 *   an empty list regardless of what the id-based rules would return.
 * - `auto` is not a ladder tier; it means "send no intent". It is offered on
 *   every model, including ones with no ladder, because omitting the field is
 *   always valid.
 *
 * Each picker keeps its own base list (Studio omits `minimal`, the probe shows
 * it) so this module annotates the list it is handed instead of replacing it.
 */
import {
  PROBE_REASONING_EFFORTS,
  clampReasoningEffort,
  resolveSupportedReasoningEfforts,
  type ReasoningEffortLevel,
} from "../data/contracts";

/** A picker row: the wire value, its label, and whether the model honors it. */
export interface ThinkingLevelOption {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
}

/** The wire a request travels; matches the backend's `WireFamily`. */
export type ThinkingWireFamily = "chat" | "messages" | "responses";

export interface ThinkingLadder {
  /** The levels this model honors, in ladder order. Empty = no reasoning. */
  readonly supported: readonly ReasoningEffortLevel[];
  /** True when the model has no effort ladder at all (`reasoning: false`). */
  readonly unsupported: boolean;
}

/**
 * Resolve a model's ladder from its catalog row.
 *
 * `wireFamily` defaults to `chat` because that is the wire both Studio and the
 * Models probe use; callers that know the row's real family should pass it.
 */
export function thinkingLadder(args: {
  readonly modelId: string;
  readonly wireFamily?: ThinkingWireFamily;
  readonly reasoning?: boolean;
}): ThinkingLadder {
  if (args.reasoning === false) return { supported: [], unsupported: true };
  const supported = resolveSupportedReasoningEfforts(
    args.modelId,
    args.wireFamily ?? "chat",
  );
  return { supported, unsupported: supported.length === 0 };
}

/** True when the model honors `value` as-is (`auto` always does). */
export function thinkingLevelSupported(ladder: ThinkingLadder, value: string): boolean {
  if (value === "auto") return true;
  return ladder.supported.includes(value as ReasoningEffortLevel);
}

/**
 * Annotate a picker's own option list with support, keeping every level visible
 * so the dropdown never changes shape under the operator: unsupported levels are
 * disabled instead of being silently downgraded at dispatch.
 *
 * `auto` is never disabled — it is the "let the route decide" escape hatch and
 * is valid on every model, including ones with no reasoning support.
 */
export function thinkingLevelOptions<T extends { readonly value: string }>(
  base: readonly T[],
  ladder: ThinkingLadder,
): Array<T & { disabled: boolean }> {
  return base.map((option) => ({
    ...option,
    disabled: !thinkingLevelSupported(ladder, option.value),
  }));
}

/**
 * The level a request at `requested` will actually run at on this model, or
 * `undefined` when the request carries no reasoning intent (`auto`/`none`).
 *
 * This is `clampReasoningEffort` verbatim, so the hint the picker renders is the
 * same number the router will apply — not a second opinion about it.
 */
export function appliedThinkingLevel(
  requested: string,
  ladder: ThinkingLadder,
): ReasoningEffortLevel | undefined {
  if (requested === "auto") return undefined;
  return clampReasoningEffort(requested, ladder.supported);
}

/**
 * The ladder a section-wide picker should offer: a level is selectable only when
 * *every* model the picker governs can honor it.
 *
 * The section dropdown is inherently global (one value fans out to every card),
 * so offering the union's superset would let an operator pick a level that some
 * cards silently downgrade — the exact confusion this change removes. The
 * intersection keeps the dropdown honest for the whole section; per-card badges
 * then explain which model fell out and why.
 *
 * An empty `models` list yields the widest ladder (nothing to contradict), so a
 * provider with no models yet still shows a usable picker.
 */
export function unionThinkingLadder(
  models: readonly {
    readonly modelId: string;
    readonly wireFamily?: string;
    readonly reasoning?: boolean;
  }[],
): ThinkingLadder {
  const ladders = models.map((model) =>
    thinkingLadder({
      modelId: model.modelId,
      wireFamily: model.wireFamily as ThinkingWireFamily | undefined,
      reasoning: model.reasoning,
    }),
  );
  if (ladders.length === 0) {
    return {
      supported: resolveSupportedReasoningEfforts("", "chat"),
      unsupported: false,
    };
  }
  // Intersection, ordered by the canonical ladder so the dropdown stays stable.
  const supported = PROBE_REASONING_EFFORTS.filter(
    (level) => level !== "auto" && ladders.every((l) => l.supported.includes(level)),
  ) as ReasoningEffortLevel[];
  return { supported, unsupported: supported.length === 0 };
}
