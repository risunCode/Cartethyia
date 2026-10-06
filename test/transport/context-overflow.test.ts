/**
 * Context-window overflow that an upstream reports only in prose.
 *
 * The payload is the verbatim WorkBuddy body from the operator's report, minus
 * the request id. Its structured identifiers say nothing about the cause
 * (`code: 11115`, `extError.type: invalid_request_error`) and only `msg` names
 * it, so reading identifiers alone classified it as a generic 400. That hid the
 * one thing a client acts on: Claude Code compacts when told the prompt
 * exceeded the window and does nothing on a 400 that looks like any other bad
 * request.
 *
 * The shape recognized here is the measured-size form ("N tokens > M"), never
 * a bare phrase — see the fourth case for why.
 */
import { describe, expect, test } from "bun:test";
import { mapUpstreamHttpError } from "../../src/transport/failure-policy";

/** The upstream body verbatim: numeric `code`, prose-only overflow. */
function overflowBody(): string {
  return JSON.stringify({
    code: 11115,
    msg: "prompt is too long: 100001 tokens > 100000 maximum",
    requestId: "e0dce747a13f43c385bddf9e64f99df8",
    extError: {
      code: 400003,
      message: "prompt is too long: 100001 tokens > 100000 maximum",
      param: "",
      type: "invalid_request_error",
      StatusCode: 400,
    },
    displayMsg: {
      en: "The request exceeds the model context limit.",
    },
  });
}

function upstreamResponse(body: string, status = 400): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Captures the GatewayError a mapping throws, since it never returns. */
async function capture(response: Response): Promise<{ code: string; status: number; message: string }> {
  try {
    await mapUpstreamHttpError(response, "workbuddy");
  } catch (error) {
    const e = error as { code: string; status: number; message: string };
    return { code: e.code, status: e.status, message: e.message };
  }
  throw new Error("mapUpstreamHttpError returned instead of throwing");
}

describe("upstream context-window overflow", () => {
  test("the reported payload is a context overflow, not a generic 400", async () => {
    const result = await capture(upstreamResponse(overflowBody()));
    expect(result.code).toBe("context_length_exceeded");
    expect(result.status).toBe(413);
  });

  test("the client is told the measured size and the ceiling", async () => {
    const result = await capture(upstreamResponse(overflowBody()));
    expect(result.message).toContain("100001");
    expect(result.message).toContain("100000");
  });

  test("an unrelated 400 keeps its generic code", async () => {
    const body = JSON.stringify({
      code: 11115,
      msg: "model not available",
      extError: { code: 400003, type: "invalid_request_error", StatusCode: 400 },
    });
    const result = await capture(upstreamResponse(body));
    expect(result.code).toBe("invalid_request");
    expect(result.status).toBe(400);
  });

  test("a client that wrote the phrase itself is not misread as overflow", async () => {
    // The words appear because the *client's own prompt* quoted them; the
    // upstream is rejecting a malformed tool call. Text matching alone would
    // mislabel this and tell the client to truncate a prompt that was fine.
    const body = JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: "tools[0].name must match ^[a-zA-Z0-9_-]{1,64}$ (prompt is too long is not a reason)",
      },
    });
    const result = await capture(upstreamResponse(body));
    expect(result.code).toBe("invalid_request");
    expect(result.status).toBe(400);
  });
});
