/**
 * Cursor provider.
 *
 * Cursor's backend is an agent protocol, not a model API, so this adapter
 * translates rather than forwards: canonical messages become history blobs
 * the server pulls back mid-stream, and the server's tool requests come back
 * as canonical tool calls for the caller to execute. The wire is Connect-RPC
 * over HTTP/2 to `api2.cursor.sh`.
 */
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../contracts";
import { CURSOR_PROVIDER_ID } from "./cursor-catalog";
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
        modelId: candidate.model_id,
        rootMessages: input.rootMessages,
        userText: input.userText,
        tools: input.tools,
        timeoutMs: TURN_TIMEOUT_MS,
        allowedNativeTools: [],
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
          // The wire reports one counter with no prompt/completion split, so
          // it is reported as output and the input fields stay unavailable
          // rather than being invented.
          yield {
            type: "usage",
            sequence_number: next(),
            usage: {
              input_tokens: 0,
              cached_input_tokens: "unavailable",
              cache_write_tokens: "unavailable",
              uncached_input_tokens: "unavailable",
              output_tokens: event.outputTokens,
              reasoning_tokens: "unavailable",
              estimated_cost: null,
              total_tokens: event.outputTokens,
            },
          };
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
