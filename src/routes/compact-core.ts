/**
 * Emulated compaction core (§10.1) — shared by Responses compact and
 * Anthropic Messages compact surfaces.
 *
 * Delegates the entire resolve → transform → credential → dispatch →
 * combo-failover chain to `dispatchQualifiedRoute`'s `compact` mode (REQ-4.2),
 * instead of re-implementing it: this is the same pipeline every /v1/* route
 * uses, so compaction now also gets account rotation and combo failover for
 * free instead of the single-shot, no-failover credential path it had before.
 *
 * No internal flags (_compact, context_management, etc.) leak to upstream.
 */

import { dispatchQualifiedRoute } from "../upstream/dispatch";
import type { OpenAIChatRequest, OpenAIChatResponse } from "../translate/types";

const DEFAULT_COMPACT_INSTRUCTION =
  "Condense the conversation above into a faithful summary. Preserve decisions, file paths, code state, pending tasks, constraints. Drop repetition, verbose tool output, resolved chatter.";

export interface CompactInput {
  model: string;
  chatReq: OpenAIChatRequest;
  headers: { authorization?: string; "x-api-key"?: string };
  request: Request;
  instruction?: string;
}

export interface CompactResult {
  text: string;
  response: OpenAIChatResponse;
}

/**
 * Runs an emulated compaction via the shared dispatch pipeline in compact
 * mode (instruction injected as the first system message, stream forced
 * off), then extracts the summary text.
 */
export async function runEmulatedCompact(input: CompactInput): Promise<CompactResult> {
  const { model, chatReq, headers, request, instruction } = input;

  const body: Record<string, unknown> = { ...chatReq, model };
  const dispatched = await dispatchQualifiedRoute({
    model,
    body,
    headers,
    request,
    surface: "openai-chat",
    compact: { instruction: instruction ?? DEFAULT_COMPACT_INSTRUCTION },
  });

  if (dispatched.kind === "error") throw new CompactError(dispatched.status, dispatched.message);

  const { result } = dispatched;
  if (result.type === "stream") {
    // Drain the stream to get the final text.
    let text = "";
    for await (const event of result.events) {
      if (event.type === "text_delta") text += event.text;
    }
    const response: OpenAIChatResponse = {
      id: `chatcmpl-compact-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return { text, response };
  }

  const responseBody = result.body as unknown as OpenAIChatResponse;
  const text = typeof responseBody.choices?.[0]?.message?.content === "string" ? responseBody.choices[0].message.content : "";
  return { text, response: responseBody };
}

/** Typed error for compaction failures — mapped to HTTP status by callers. */
export class CompactError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
