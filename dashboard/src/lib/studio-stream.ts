import { isRecord } from "./api";

/**
 * Incremental OpenAI chat-completions SSE parsing for the Studio page.
 * Pure helpers (unit-tested) plus a thin async pump over a fetch body.
 */

export interface StreamToolCall {
  readonly id: string;
  readonly index?: number;
  name?: string;
  args: string;
}

export interface ChatStreamAccumulator {
  text: string;
  reasoning: string;
  finishReason?: string;
  /** Tool-call deltas merged by wire index (falling back to id). */
  toolCalls: StreamToolCall[];
  // Backend `StudioMessageUsage` names (input/output/…), mapped from the
  // OpenAI wire at parse time so the transcript persists without translation.
  usage?: {
    readonly input?: number;
    readonly output?: number;
    readonly reasoning?: number;
    readonly cached?: number;
    readonly total?: number;
  };
}

export function createChatStreamAccumulator(): ChatStreamAccumulator {
  return { text: "", reasoning: "", toolCalls: [] };
}

/** Human duration: `6479ms` stays ms, seconds get one decimal. */
export function formatStudioMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Splits an SSE buffer into complete `data:` payloads, keeping the tail. */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    for (const line of part.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) frames.push(trimmed.slice(5).trim());
    }
  }
  return { frames, rest };
}

function readDeltaText(choice: Record<string, unknown>): string | undefined {
  const delta = choice["delta"];
  if (!isRecord(delta)) return undefined;
  const content = delta["content"];
  return typeof content === "string" ? content : undefined;
}

function readDeltaReasoning(choice: Record<string, unknown>): string | undefined {
  const delta = choice["delta"];
  if (!isRecord(delta)) return undefined;
  const reasoning = delta["reasoning_content"];
  return typeof reasoning === "string" ? reasoning : undefined;
}

function readUsage(json: Record<string, unknown>): ChatStreamAccumulator["usage"] {
  const usage = json["usage"];
  if (!isRecord(usage)) return undefined;
  const input = typeof usage["prompt_tokens"] === "number" ? usage["prompt_tokens"] : undefined;
  const output =
    typeof usage["completion_tokens"] === "number" ? usage["completion_tokens"] : undefined;
  const completionDetails = usage["completion_tokens_details"];
  const reasoning =
    isRecord(completionDetails) && typeof completionDetails["reasoning_tokens"] === "number"
      ? completionDetails["reasoning_tokens"]
      : undefined;
  const promptDetails = usage["prompt_tokens_details"];
  const cached =
    isRecord(promptDetails) && typeof promptDetails["cached_tokens"] === "number"
      ? promptDetails["cached_tokens"]
      : undefined;
  const total = typeof usage["total_tokens"] === "number" ? usage["total_tokens"] : undefined;
  if (
    input === undefined &&
    output === undefined &&
    reasoning === undefined &&
    cached === undefined &&
    total === undefined
  )
    return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(cached === undefined ? {} : { cached }),
    ...(total === undefined ? {} : { total }),
  };
}

/** Folds one SSE `data:` payload into the accumulator. `[DONE]` is a no-op. */
export function applyChatFrame(acc: ChatStreamAccumulator, frame: string): void {
  if (frame === "[DONE]" || frame.length === 0) return;
  let json: unknown;
  try {
    json = JSON.parse(frame) as unknown;
  } catch {
    return;
  }
  if (!isRecord(json)) return;
  // Gateway stream error envelope (emitStreamErrorAndClose): a top-level
  // `error` object with no `choices`. Swallowing it produces a confusing
  // "(no visible output)" downstream — surface it as a thrown error instead.
  if (json["choices"] === undefined && isRecord(json["error"])) {
    const message = json["error"]["message"];
    throw new Error(typeof message === "string" && message.length > 0 ? message : "Upstream stream failed");
  }
  const choices = json["choices"];
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (isRecord(first)) {
      const text = readDeltaText(first);
      if (text !== undefined) acc.text += text;
      const reasoning = readDeltaReasoning(first);
      if (reasoning !== undefined) acc.reasoning += reasoning;
      mergeDeltaToolCalls(acc, first);
      if (typeof first["finish_reason"] === "string") acc.finishReason = first["finish_reason"];
    }
  }
  const usage = readUsage(json);
  if (usage !== undefined) acc.usage = usage;
}

function mergeDeltaToolCalls(acc: ChatStreamAccumulator, choice: Record<string, unknown>): void {
  const delta = choice["delta"];
  if (!isRecord(delta)) return;
  const calls = delta["tool_calls"];
  if (!Array.isArray(calls)) return;
  for (const raw of calls) {
    if (!isRecord(raw)) continue;
    const fn = raw["function"];
    if (!isRecord(fn)) continue;
    const index = typeof raw["index"] === "number" ? raw["index"] : undefined;
    const id = typeof raw["id"] === "string" ? raw["id"] : undefined;
    const name = typeof fn["name"] === "string" ? fn["name"] : undefined;
    const args = typeof fn["arguments"] === "string" ? fn["arguments"] : "";
    const key = index ?? id;
    const existing =
      key === undefined
        ? undefined
        : acc.toolCalls.find((call) => (call.index ?? call.id) === key);
    if (existing) {
      existing.args += args;
      if (existing.name === undefined) existing.name = name;
    } else {
      acc.toolCalls.push({
        id: id ?? `stream-${acc.toolCalls.length}`,
        ...(index === undefined ? {} : { index }),
        ...(name === undefined ? {} : { name }),
        args,
      });
    }
  }
}

export interface ChatStreamCallbacks {
  onUpdate: (acc: ChatStreamAccumulator) => void;
}

/**
 * Pumps an OpenAI SSE response body into `acc`, invoking `onUpdate` per
 * frame. Resolves with the final accumulator; rejects on non-2xx with the
 * upstream `error.message` when the body carries one.
 */
export async function pumpChatStream(
  response: Response,
  acc: ChatStreamAccumulator,
  callbacks: ChatStreamCallbacks,
  signal?: AbortSignal,
): Promise<ChatStreamAccumulator> {
  if (!response.ok || !response.body) {
    let message = `Request failed with HTTP ${response.status}`;
    try {
      const body = (await response.json()) as unknown;
      if (isRecord(body) && isRecord(body["error"]) && typeof body["error"]["message"] === "string")
        message = body["error"]["message"] as string;
    } catch {
      /* keep the status fallback */
    }
    throw new Error(message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        return acc;
      }
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const { frames, rest } = splitSseFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        applyChatFrame(acc, frame);
        callbacks.onUpdate(acc);
      }
      if (done) {
        if (buffer.trim().length > 0) {
          applyChatFrame(acc, buffer.trim());
          callbacks.onUpdate(acc);
        }
        return acc;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
