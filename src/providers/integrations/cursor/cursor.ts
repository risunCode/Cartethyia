/**
 * Cursor provider.
 *
 * Cursor's backend is an agent protocol, not a model API, so this adapter
 * translates rather than forwards: canonical messages become history blobs
 * the server pulls back mid-stream, and the server's tool requests come back
 * as canonical tool calls for the caller to execute. The wire is Connect-RPC
 * over HTTP/2 to `api2.cursor.sh`.
 */
import type { CanonicalEvent, CanonicalRequest, UsageRecord } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../contracts";
import { CURSOR_PROVIDER_ID, upstreamModelId } from "./cursor-catalog";
import { buildTurnInput, cursorTools } from "./cursor-translate";
import { runTurn, type TurnEvent } from "./cursor-turn";

const CLIENT_VERSION = "cli-2026.08.11";
const TURN_TIMEOUT_MS = 300_000;

export class CursorAdapter implements ProviderAdapter {
  readonly provider_id = CURSOR_PROVIDER_ID;

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    const secret = context.credential.secret;
    if (!secret || secret.length === 0) {
      throw new GatewayError("authentication_failed", 401, "Cursor requires a signed-in account", {
        providerId: CURSOR_PROVIDER_ID,
      });
    }
    const token = new TextDecoder().decode(secret).trim();
    if (!token) {
      throw new GatewayError("authentication_failed", 401, "Empty Cursor credential", {
        providerId: CURSOR_PROVIDER_ID,
      });
    }

    const input = buildTurnInput(request.messages, cursorTools(request.tools ?? []));
    let sequence = 0;
    const next = (): number => {
      sequence += 1;
      return sequence;
    };
    yield { type: "message_start", sequence_number: next(), model: candidate.model_id };

    let turn: AsyncGenerator<TurnEvent>;
    try {
      turn = runTurn({
        token,
        clientVersion: CLIENT_VERSION,
        signal: context.abort_signal,
        modelId: upstreamModelId(candidate.model_id),
        rootMessages: input.rootMessages,
        userText: input.userText,
        tools: input.tools,
        timeoutMs: TURN_TIMEOUT_MS,
        // Cursor's own web search. The allow-list hides every other native
        // tool, so the model cannot shell out or edit files on the caller's
        // behalf, but it can still search.
        allowedNativeTools: ["web_search_tool_call"],
      });
    } catch (error) {
      throw gatewayErrorFor(error);
    }

    try {
      for await (const event of turn) {
        if (event.type === "text") {
          yield { type: "content_delta", sequence_number: next(), content: { kind: "text", text: event.delta } };
        } else if (event.type === "thinking") {
          yield { type: "content_delta", sequence_number: next(), content: { kind: "reasoning", payload: event.delta, summary: event.delta } };
        } else if (event.type === "tool_call") {
          yield {
            type: "tool_call_delta",
            sequence_number: next(),
            call_id: event.id,
            name: event.name,
            arguments_delta: JSON.stringify(event.args),
          };
        } else if (event.type === "usage") {
          yield { type: "usage", sequence_number: next(), usage: usageRecord(event) };
        } else if (event.type === "done") {
          if (event.reason === "error") throw gatewayErrorForCode(event.code, event.error);
          yield {
            type: "terminal",
            sequence_number: next(),
            state: "complete",
            stop_reason: event.reason === "tool_calls" ? "tool_use" : "stop",
          };
          return;
        }
      }
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw gatewayErrorFor(error);
    }
  }
}

/**
 * Cursor's final frame counts the whole prompt as input, cache included, so
 * fresh input is what remains after the cache read and write are taken out.
 * A counter the frame did not report stays `unavailable` rather than zero:
 * zero would claim Cursor measured nothing, which is a different fact.
 */
function usageRecord(event: Extract<TurnEvent, { type: "usage" }>): UsageRecord {
  const cacheRead = event.cacheReadTokens ?? 0;
  const cacheWrite = event.cacheWriteTokens ?? 0;
  const input = event.inputTokens;
  const fresh = input === undefined ? undefined : Math.max(input - cacheRead - cacheWrite, 0);
  const output = event.outputTokens ?? 0;
  return {
    input_tokens: fresh ?? 0,
    cached_input_tokens: event.cacheReadTokens ?? "unavailable",
    cache_write_tokens: event.cacheWriteTokens ?? "unavailable",
    uncached_input_tokens: fresh ?? "unavailable",
    output_tokens: output,
    reasoning_tokens: event.reasoningTokens ?? "unavailable",
    estimated_cost: null,
    total_tokens: (fresh ?? 0) + output + cacheRead + cacheWrite,
  };
}

function gatewayErrorForCode(code: string | undefined, message: string | undefined): GatewayError {
  const detail = message ?? "Cursor upstream error";
  if (code === "resource_exhausted") return new GatewayError("quota_exceeded", 429, detail, { providerId: CURSOR_PROVIDER_ID });
  if (code === "unauthenticated") return new GatewayError("authentication_failed", 401, detail, { providerId: CURSOR_PROVIDER_ID });
  if (code === "permission_denied") return new GatewayError("policy_rejected", 403, detail, { providerId: CURSOR_PROVIDER_ID });
  return new GatewayError("platform_unavailable", 502, detail, { providerId: CURSOR_PROVIDER_ID });
}

function gatewayErrorFor(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new GatewayError("platform_unavailable", 502, `Cursor transport failed: ${message}`, { providerId: CURSOR_PROVIDER_ID });
}

export const cursorAdapter: ProviderAdapter = new CursorAdapter();
