/**
 * Token-speed (tokens/sec) computation shared by live-traffic telemetry
 * (`transport/middleware/ingress.ts`) and model probes
 * (`providers/discovery/provider-probing-service.ts`) so both report the
 * same number for the same observation.
 *
 * Definition follows the industry standard for decode throughput:
 * - llama.cpp reports `predicted_per_second = n_decoded / t_token_generation`
 *   (generated tokens over pure decode time, prompt processing excluded).
 * - Ollama documents `eval_count / eval_duration` for both streaming and
 *   non-streaming responses.
 * - OpenRouter models `total latency = TTFT + output_tokens / TPS`, i.e.
 *   TPS excludes the prefill/TTFT phase.
 * - Langfuse tracks `outputTokensPerSecond = output / (end - completion_start)`
 *   and separately `tokensPerSecond = total / (end - start)`.
 *
 * A gateway proxying third-party providers cannot measure upstream decode
 * time directly. The closest observable decode window is the span between
 * the first streamed content delta and the last stream event, so:
 * - streaming requests with an observed token window report true decode
 *   speed: `output_tokens / (lastEvent - firstContent)`;
 * - otherwise (non-streaming, or all content arriving in a single chunk)
 *   the decode phase happened upstream inside TTFT and is unobservable.
 *   Reporting `output / (latency - TTFT)` there divides by milliseconds of
 *   local overhead and produced absurd 7000+ tok/s rows, so those cases
 *   report end-to-end effective speed `output_tokens / latency` instead —
 *   a conservative lower bound that is always well-defined.
 *
 * Note the `stream` gate matters beyond the degenerate-window fallback:
 * non-streaming dispatches also observe internal upstream-event timestamps,
 * but those spans measure local response processing, not decode. Only a
 * client-visible stream window counts as decode time.
 */
export interface TokenSpeedInput {
  /** Completion/output tokens reported for the request. */
  readonly outputTokens?: number | undefined;
  /** End-to-end gateway latency in milliseconds. */
  readonly latencyMs: number;
  /** Whether the client asked for a streamed response. */
  readonly stream?: boolean | undefined;
  /** Wall-clock ms of the first streamed content delta, when observed. */
  readonly firstContentDeltaAtMs?: number | undefined;
  /** Wall-clock ms of the last streamed event, when observed. */
  readonly lastEventAtMs?: number | undefined;
}

/**
 * Computes tokens/sec for one request, or `undefined` when there is nothing
 * meaningful to divide (no output tokens, or no elapsed time).
 */
export function computeTokensPerSec(input: TokenSpeedInput): number | undefined {
  const outputTokens = input.outputTokens;
  if (outputTokens === undefined || outputTokens <= 0) return undefined;
  if (input.stream === true) {
    const first = input.firstContentDeltaAtMs;
    const last = input.lastEventAtMs;
    if (first !== undefined && last !== undefined) {
      const decodeMs = last - first;
      if (decodeMs > 0) return (outputTokens / decodeMs) * 1000;
    }
  }
  if (input.latencyMs > 0) return (outputTokens / input.latencyMs) * 1000;
  return undefined;
}
