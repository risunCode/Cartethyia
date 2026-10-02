/**
 * Model fusion: a combo strategy that fans a prompt out to every panel model in
 * parallel, then has one judge model synthesize a single final answer.
 *
 * This module owns only the *pure* orchestration — the judge directive, the
 * panel collection policy (quorum grace + hard timeout), and the fan-out shape.
 * The actual per-model dispatch is injected as `dispatchPanel`, so the same
 * engine serves any surface and any provider without importing the transport
 * pipeline: a caller passes a function that runs one canonical request against
 * one model and returns its text (or throws).
 *
 * The judge directive is deliberately analysis-first (consensus /
 * contradictions / partial coverage / unique insight / blind spots) and
 * source-anonymized, so the judge weighs substance rather than a model's
 * reputation — that synthesis step is where most of fusion's quality lift comes
 * from.
 */

/** One panel model's answer, tagged with the model that produced it. */
export interface FusionAnswer {
  readonly model: string;
  readonly text: string;
}

/** Fusion tuning, overridable per call. */
export interface FusionTuning {
  /** Successful answers needed before stragglers get only a grace window. */
  readonly minPanel: number;
  /** How long to wait for laggards once quorum is reached. */
  readonly stragglerGraceMs: number;
  /** Absolute cap so one hung panel model cannot stall the whole request. */
  readonly panelHardTimeoutMs: number;
}

export const FUSION_DEFAULTS: FusionTuning = {
  minPanel: 2,
  stragglerGraceMs: 8_000,
  panelHardTimeoutMs: 90_000,
};

/** A panel member that produced no answer: it failed, timed out, or was dropped. */
export interface FusionPanelFailure {
  readonly model: string;
  readonly reason: "error" | "timeout" | "empty";
}

export interface FusionPanelOutcome {
  readonly answers: readonly FusionAnswer[];
  readonly failures: readonly FusionPanelFailure[];
}

/**
 * Collects panel results with quorum-grace: as soon as `minPanel` succeed, a
 * short grace timer starts for the rest and the collection resolves with
 * whatever arrived; a hard timeout caps the wait regardless. Returns the
 * successful answers plus the failures, so the caller can log them.
 *
 * `results` is aligned to `models`; a rejected promise is a failure, not a
 * thrown error, so one model's failure never aborts the panel.
 */
export async function collectFusionPanel(
  models: readonly string[],
  results: readonly Promise<string>[],
  tuning: FusionTuning,
): Promise<FusionPanelOutcome> {
  const minPanel = Math.min(Math.max(2, tuning.minPanel), models.length);
  const settled: Array<{ ok: true; text: string } | { ok: false } | undefined> = new Array(
    models.length,
  );
  await new Promise<void>((resolve) => {
    let outstanding = models.length;
    let ok = 0;
    let finished = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve();
    };
    const hardTimer = setTimeout(finish, tuning.panelHardTimeoutMs);
    results.forEach((promise, index) => {
      promise
        .then((text) => {
          settled[index] = { ok: true, text };
        })
        .catch(() => {
          settled[index] = { ok: false };
        })
        .finally(() => {
          outstanding -= 1;
          if (settled[index]?.ok === true) ok += 1;
          if (outstanding === 0) {
            finish();
            return;
          }
          if (ok >= minPanel && graceTimer === undefined) graceTimer = setTimeout(finish, tuning.stragglerGraceMs);
        });
    });
  });

  const answers: FusionAnswer[] = [];
  const failures: FusionPanelFailure[] = [];
  for (let index = 0; index < models.length; index++) {
    const model = models[index]!;
    const result = settled[index];
    if (result === undefined) {
      failures.push({ model, reason: "timeout" });
    } else if (result.ok) {
      if (result.text.trim().length === 0) failures.push({ model, reason: "empty" });
      else answers.push({ model, text: result.text });
    } else {
      failures.push({ model, reason: "error" });
    }
  }
  return { answers, failures };
}

/**
 * Builds the judge directive from the panel answers.
 *
 * Sources are anonymized (`Source N`) so the judge weighs substance, not the
 * reputation of a model brand, and the directive tells the judge to analyze
 * before writing rather than to merge mechanically.
 */
export function buildFusionJudgePrompt(answers: readonly FusionAnswer[]): string {
  const panel = answers.map((answer, index) => `[Source ${index + 1}]\n${answer.text}`).join("\n\n");
  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

/**
 * Runs the panel half of a fusion combo and decides the next step.
 *
 * `panel` is the member models. `dispatchPanel(model)` runs the prompt against
 * one panel model and resolves with its answer text. Returns one of:
 *
 * - `{ kind: "empty" }` — every panel model failed; the caller answers 503.
 * - `{ kind: "direct", answer, model }` — exactly one survived, nothing to fuse.
 * - `{ kind: "judge", prompt, judgeModel, panelSize }` — two or more answered;
 *   the caller runs `prompt` against `judgeModel` and encodes that result.
 *
 * Splitting here (rather than having this function also call the judge) keeps
 * the judge's surface encoding in the caller, where the streaming response and
 * the request lifecycle already live.
 */
export async function runFusionPanel(input: {
  readonly panel: readonly string[];
  readonly judge: string;
  readonly tuning?: Partial<FusionTuning>;
  readonly dispatchPanel: (model: string) => Promise<string>;
}):
  Promise<
    | { readonly kind: "empty" }
    | { readonly kind: "direct"; readonly answer: string; readonly model: string }
    | {
        readonly kind: "judge";
        readonly prompt: string;
        readonly judgeModel: string;
        readonly panelSize: number;
      }
  > {
  const tuning: FusionTuning = { ...FUSION_DEFAULTS, ...(input.tuning ?? {}) };
  const outcome = await collectFusionPanel(
    input.panel,
    input.panel.map((model) => input.dispatchPanel(model)),
    tuning,
  );
  if (outcome.answers.length === 0) return { kind: "empty" };
  if (outcome.answers.length === 1) {
    const only = outcome.answers[0]!;
    return { kind: "direct", answer: only.text, model: only.model };
  }
  return {
    kind: "judge",
    prompt: buildFusionJudgePrompt(outcome.answers),
    judgeModel: input.judge,
    panelSize: input.panel.length,
  };
}

/** Every panel model failed (or timed out) before producing an answer. */
export class FusionEmptyPanelError extends Error {
  constructor() {
    super("all fusion panel models failed");
    this.name = "FusionEmptyPanelError";
  }
}
