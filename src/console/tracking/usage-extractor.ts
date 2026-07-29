/**
 * Usage extraction — pulls token totals out of final response bodies or the
 * terminal SSE payload, across the three client-facing shapes.
 */

export interface UsageTotals {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  source: "provider" | "missing";
}

const MISSING: UsageTotals = {
  inputTokens: null,
  outputTokens: null,
  cachedTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  totalTokens: null,
  source: "missing",
};

type SurfaceShape = "chat" | "anthropic" | "responses";

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asObj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function extractUsage(shape: SurfaceShape, body: unknown): UsageTotals {
  const root = asObj(body);
  const usage = asObj(root?.usage);
  if (!usage) return { ...MISSING };

  if (shape === "anthropic") {
    const input = num(usage.input_tokens);
    const output = num(usage.output_tokens);
    if (input === null && output === null) return { ...MISSING };
    return {
      inputTokens: input,
      outputTokens: output,
      cachedTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
      reasoningTokens: null,
      totalTokens: input !== null && output !== null ? input + output : null,
      source: "provider",
    };
  }

  if (shape === "responses") {
    const input = num(usage.input_tokens);
    const output = num(usage.output_tokens);
    if (input === null && output === null) return { ...MISSING };
    const inputDetails = asObj(usage.input_tokens_details);
    const outputDetails = asObj(usage.output_tokens_details);
    return {
      inputTokens: input,
      outputTokens: output,
      cachedTokens: num(inputDetails?.cached_tokens),
      cacheWriteTokens: null,
      reasoningTokens: num(outputDetails?.reasoning_tokens),
      totalTokens: num(usage.total_tokens) ?? (input !== null && output !== null ? input + output : null),
      source: "provider",
    };
  }

  // openai chat
  const input = num(usage.prompt_tokens);
  const output = num(usage.completion_tokens);
  if (input === null && output === null) return { ...MISSING };
  const promptDetails = asObj(usage.prompt_tokens_details);
  const completionDetails = asObj(usage.completion_tokens_details);
  return {
    inputTokens: input,
    outputTokens: output,
    cachedTokens: num(promptDetails?.cached_tokens),
    cacheWriteTokens: null,
    reasoningTokens: num(completionDetails?.reasoning_tokens),
    totalTokens: num(usage.total_tokens) ?? (input !== null && output !== null ? input + output : null),
    source: "provider",
  };
}

/**
 * Scans accumulated SSE text and returns the last payload carrying usage
 * (chat chunk with usage, anthropic message_delta usage, or a responses
 * response.completed wrapper), then extracts totals by key sniffing.
 */
export function extractUsageFromSseText(shape: SurfaceShape, text: string): UsageTotals {
  let usage: Record<string, unknown> | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const direct = asObj(parsed.usage);
      if (direct) {
        usage = direct;
        continue;
      }
      const wrapper = asObj(parsed.response);
      const nested = asObj(wrapper?.usage);
      if (nested) usage = nested;
    } catch {
      // partial frame — ignore
    }
  }
  if (!usage) return { ...MISSING };
  if (shape === "anthropic") return extractUsage("anthropic", { usage });
  if (shape === "responses") return extractUsage("responses", { usage });
  if (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined) return extractUsage("chat", { usage });
  return extractUsage("responses", { usage });
}

/** Extracts tool-call metadata from a final response body (meta only). */
export interface ToolCallMeta {
  name: string;
  bytes: number;
  sha256: string;
  status: string;
}

export function extractToolCalls(shape: SurfaceShape, body: unknown): ToolCallMeta[] {
  const root = asObj(body);
  if (!root) return [];
  const out: ToolCallMeta[] = [];
  const hash = (text: string) => {
    const h = new Bun.CryptoHasher("sha256");
    h.update(text);
    return h.digest("hex").slice(0, 16);
  };

  if (shape === "anthropic") {
    const content = Array.isArray(root.content) ? root.content : [];
    for (const block of content) {
      const b = asObj(block);
      if (b?.type !== "tool_use") continue;
      const input = JSON.stringify(b.input ?? null);
      out.push({ name: String(b.name ?? "unknown"), bytes: input.length, sha256: hash(input), status: "ok" });
    }
    return out;
  }

  if (shape === "responses") {
    const output = Array.isArray(root.output) ? root.output : [];
    for (const item of output) {
      const i = asObj(item);
      if (i?.type !== "function_call") continue;
      const args = String(i.arguments ?? "");
      out.push({ name: String(i.name ?? "unknown"), bytes: args.length, sha256: hash(args), status: String(i.status ?? "ok") });
    }
    return out;
  }

  const choices = Array.isArray(root.choices) ? root.choices : [];
  for (const choice of choices) {
    const message = asObj(asObj(choice)?.message);
    const toolCalls = Array.isArray(message?.tool_calls) ? message!.tool_calls : [];
    for (const call of toolCalls) {
      const c = asObj(call);
      const fn = asObj(c?.function);
      const args = String(fn?.arguments ?? "");
      out.push({ name: String(fn?.name ?? "unknown"), bytes: args.length, sha256: hash(args), status: "ok" });
    }
  }
  return out;
}
