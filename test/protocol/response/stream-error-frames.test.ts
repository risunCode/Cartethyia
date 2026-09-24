import { describe, expect, test } from "bun:test";
import { decodeChatSseStream } from "../../../src/protocol/response/chat";
import { decodeResponsesSseStream } from "../../../src/protocol/response/responses";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";
import type { GatewayError } from "../../../src/transport/gateway-error";
import { streamOf } from "../../helpers/sse-fixtures";

/**
 * An explicit error frame inside a 200 OK must reach the client as a typed
 * error, not as a bare `failed` terminal.
 *
 * These surfaces used to record the frame only as a terminal state, so the
 * client received no `error.code` and telemetry recorded `unknown_error` for a
 * failure the upstream had described exactly. The Claude and Gemini decoders
 * already raised; these tests pin that the OpenAI-family surfaces now match.
 */
function request(surface: "chat" | "responses"): CanonicalRequest {
  return { model: "test-model", source_surface: surface } as CanonicalRequest;
}

async function capture(gen: AsyncIterable<unknown>): Promise<GatewayError> {
  try {
    for await (const _event of gen) {
      // Drain: the throw may land after earlier frames were yielded.
    }
  } catch (error) {
    return error as GatewayError;
  }
  throw new Error("expected the decoder to throw");
}

describe("error frames inside a 200 OK", () => {
  test("chat: a rate-limit frame becomes quota_exceeded, not a failed terminal", async () => {
    const body = streamOf('data: {"error":{"type":"rate_limit_exceeded","message":"slow down"}}\n\n' + "data: [DONE]\n\n");
    const error = await capture(decodeChatSseStream(body, request("chat")));
    expect(error).toMatchObject({ code: "quota_exceeded", status: 429, origin: "upstream" });
    expect(error.message).toBe("slow down");
  });

  test("chat: an overload frame becomes platform_unavailable", async () => {
    const body = streamOf('data: {"error":{"type":"server_error","message":"busy"}}\n\n' + "data: [DONE]\n\n");
    expect(await capture(decodeChatSseStream(body, request("chat")))).toMatchObject({
      code: "platform_unavailable",
      status: 502,
      origin: "upstream",
    });
  });

  test("chat: a context overflow keeps its own code", async () => {
    const body = streamOf('data: {"error":{"code":"context_length_exceeded"}}\n\n' + "data: [DONE]\n\n");
    expect(await capture(decodeChatSseStream(body, request("chat")))).toMatchObject({
      code: "context_length_exceeded",
      status: 413,
    });
  });

  test("chat: a normal stream still completes", async () => {
    const body = streamOf('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n' + "data: [DONE]\n\n");
    const events: Array<{ type?: string; state?: string }> = [];
    for await (const event of decodeChatSseStream(body, request("chat")))
      events.push(event as { type?: string; state?: string });
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete" });
  });

  test("responses: a response.failed frame becomes a typed error", async () => {
    const body = streamOf(
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"boom"}}}\n\n',
    );
    expect(await capture(decodeResponsesSseStream(body, request("responses")))).toMatchObject({
      code: "platform_unavailable",
      status: 502,
      origin: "upstream",
      message: "boom",
    });
  });

  test("responses: a top-level error frame becomes a typed error", async () => {
    const body = streamOf('event: error\ndata: {"type":"error","code":"rate_limit_exceeded","message":"slow"}\n\n');
    expect(await capture(decodeResponsesSseStream(body, request("responses")))).toMatchObject({
      code: "quota_exceeded",
      status: 429,
    });
  });

  test("responses: a completed response is untouched", async () => {
    const body = streamOf(
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}\n\n',
    );
    const events: Array<{ type?: string; state?: string }> = [];
    for await (const event of decodeResponsesSseStream(body, request("responses")))
      events.push(event as { type?: string; state?: string });
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete" });
  });
});
