/**
 * Gemini `generateContent` response decoder: candidate/parts extraction,
 * function-call parsing, usage mapping, and stop-reason mapping.
 *
 * The SSE event framing lives here too: Gemini and Antigravity both stream
 * `data:` chunks carrying one Gemini payload, and both must reject a corrupt
 * line rather than read it as a short success. They differ only in what
 * `[DONE]` means (Gemini skips it, Antigravity stops) and in the label used
 * for an error payload, so those are the two inputs.
 */
import type { CanonicalStopReason } from "../../transport/canonical-model";
import { GatewayError } from "../../transport/gateway-error";
import { isRecord } from "../primitives";

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function geminiCandidate(body: Record<string, unknown>): {
  readonly response: Record<string, unknown>;
  readonly candidate: Record<string, unknown>;
  readonly parts: readonly Record<string, unknown>[];
} {
  const response = isRecord(body["response"]) ? (body["response"] as Record<string, unknown>) : body;
  const candidates = response["candidates"];
  const candidate = Array.isArray(candidates) && isRecord(candidates[0]) ? (candidates[0] as Record<string, unknown>) : {};
  const content = isRecord(candidate["content"]) ? (candidate["content"] as Record<string, unknown>) : {};
  const parts = Array.isArray(content["parts"]) ? (content["parts"] as unknown[]).filter(isRecord) : [];
  return { response, candidate, parts };
}

export function responseParts(parts: readonly Record<string, unknown>[]): {
  readonly text: string;
  readonly calls: readonly { readonly id: string; readonly name: string; readonly args: Record<string, unknown> }[];
  readonly thought: string;
} {
  const text: string[] = [];
  const thought: string[] = [];
  const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  let callIndex = 0;
  for (const part of parts) {
    if (typeof part["text"] === "string") {
      if (part["thought"] === true) {
        thought.push(part["text"] as string);
      } else text.push(part["text"] as string);
    }
    if (isRecord(part["functionCall"]) && typeof (part["functionCall"] as Record<string, unknown>)["name"] === "string") {
      const fc = part["functionCall"] as Record<string, unknown>;
      calls.push({
        id: typeof fc["id"] === "string" ? (fc["id"] as string) : `call_${callIndex++}`,
        name: fc["name"] as string,
        args: isRecord(fc["args"]) ? (fc["args"] as Record<string, unknown>) : {},
      });
    }
  }
  return { text: text.join(""), calls, thought: thought.join("") };
}

export function mapGeminiUsage(body: Record<string, unknown>): Record<string, unknown> {
  const usage = isRecord(body["usageMetadata"]) ? (body["usageMetadata"] as Record<string, unknown>) : {};
  return {
    input_tokens: nullableNumber(usage["promptTokenCount"]) ?? 0,
    output_tokens: nullableNumber(usage["candidatesTokenCount"]) ?? 0,
    total_tokens: nullableNumber(usage["totalTokenCount"]) ?? 0,
    cached_tokens: nullableNumber(usage["cachedContentTokenCount"]) ?? 0,
  };
}

export function toCanonicalStopReason(candidate: Record<string, unknown>, calls: number): CanonicalStopReason {
  if (calls > 0) return "tool_use";
  if (candidate["finishReason"] === "MAX_TOKENS") return "length";
  return "stop";
}

/**
 * Decodes one SSE `data:` payload from a Gemini-family stream.
 *
 * Returns `undefined` for a line the caller should ignore: an empty payload or
 * a non-object. Throws `GatewayError("platform_unavailable", 502)` for a line
 * that cannot be trusted — a malformed JSON body or an upstream error
 * envelope. A corrupt line is a corrupt stream, never a short success, and the
 * fault is the upstream's: labelling it `invalid_request` told the client its
 * own request was malformed.
 *
 * The caller handles `[DONE]` itself, because the two Gemini-family streams
 * disagree about it: Gemini skips the marker and keeps reading, Antigravity
 * stops. Folding that into a return value would have to encode "stop the loop"
 * as data, so it stays at the call site where the loop lives.
 *
 * `errorLabel` is the fallback message for an error envelope with no string
 * `message`; each caller keeps its own so an operator can tell which upstream
 * produced the failure.
 */
export function decodeGeminiStreamEvent(
  rawData: string,
  errorLabel: string,
): Record<string, unknown> | undefined {
  const data = rawData.trim();
  if (!data) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error: unknown) {
    throw new GatewayError(
      "platform_unavailable",
      502,
      error instanceof Error ? `Malformed SSE event: ${error.message}` : "Malformed SSE event",
      {},
      "upstream",
    );
  }
  if (!isRecord(parsed)) return undefined;
  if (isRecord(parsed["error"])) {
    const err = parsed["error"] as Record<string, unknown>;
    throw new GatewayError(
      "platform_unavailable",
      502,
      typeof err["message"] === "string" ? (err["message"] as string).slice(0, 500) : errorLabel,
      {},
      "upstream",
    );
  }
  return parsed;
}
