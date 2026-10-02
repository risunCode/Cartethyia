/**
 * MiniMax Agent dispatch.
 *
 * `agent.minimax.io` is not a completion endpoint: a request is an agent-list
 * lookup, a session create, then a message whose answer streams back as SSE.
 * The upstream also validates the reasoning block strictly — it accepts only
 * the five named efforts and rejects anything else with
 * `invalid params, invalid reasoning_effort: "default"`, which it delivers as
 * an ordinary assistant message rather than an HTTP error. A gateway that sent
 * a default would therefore answer 200 with the rejection text as the
 * completion, zero usage, and `stop` as the finish reason.
 *
 * These cases pin the handshake order, the effort handling that keeps that
 * rejection off the wire, the credential shapes the harvester writes, and the
 * chunk/final-envelope de-duplication.
 */
import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../../src/transport/gateway-error";
import type { CanonicalEvent, CanonicalRequest, ReasoningEffort } from "../../../src/transport/canonical-model";
import {
  MINIMAX_MODELS,
  buildMinimaxModelBlock,
  buildMinimaxParams,
  createMinimaxAdapter,
  parseMinimaxCredential,
  transformMinimaxPayload,
  transformMinimaxSse,
  type MinimaxStreamState,
} from "../../../src/providers/integrations/minimax";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../../src/providers/provider-registry";

const MODEL = "MiniMax-M2.7";

function requestWithEffort(effort?: ReasoningEffort): CanonicalRequest {
  return {
    model: MODEL,
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    stream: true,
    source_surface: "chat",
  };
}

function candidateFor(wireFamily: ProviderDispatchTarget["wire_family"]): ProviderDispatchTarget {
  return {
    provider_id: "minimax",
    model_id: MODEL,
    wire_family: wireFamily,
    endpoint_path: "/v1/chat/completions",
    capabilities: {},
  };
}

function contextFor(secret: string): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "minimax",
      credential_kind: "api_key",
      secret: new TextEncoder().encode(secret),
    },
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
  };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function collect(iterable: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function freshState(): MinimaxStreamState {
  return { sawChunk: false, finishReason: undefined, usage: undefined };
}

function textOf(events: readonly CanonicalEvent[]): string {
  return events
    .map((event) => {
      if (event.type !== "content_delta") return "";
      const content = event.content;
      return content.kind === "text" ? content.text : "";
    })
    .join("");
}

describe("MiniMax Agent model block", () => {
  test("omits the thinking block when the request names no effort", () => {
    expect(buildMinimaxModelBlock(MODEL, requestWithEffort())).not.toHaveProperty("thinking");
  });

  test("omits the thinking block for none and minimal", () => {
    expect(buildMinimaxModelBlock(MODEL, requestWithEffort("none"))).not.toHaveProperty("thinking");
    expect(buildMinimaxModelBlock(MODEL, requestWithEffort("minimal"))).not.toHaveProperty("thinking");
  });

  test("passes through every effort the upstream accepts", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(buildMinimaxModelBlock(MODEL, requestWithEffort(effort))["thinking"]).toEqual({ effort });
    }
  });

  test("carries the catalogued context limit and model id", () => {
    const block = buildMinimaxModelBlock(MODEL, requestWithEffort());
    expect(block["model_id"]).toBe(MODEL);
    expect(block["provider_id"]).toBe("minimax");
    expect(block["context_limit"]).toBe(
      MINIMAX_MODELS.find((model) => model.modelId === MODEL)?.contextLimit ?? 0,
    );
  });
});

describe("MiniMax Agent credential", () => {
  test("reads the jwt, cookie jar, and account id from the harvester's JSON shape", () => {
    const credential = parseMinimaxCredential(
      JSON.stringify({
        email: "a@b.test",
        password: "p",
        cookie: "k=v",
        jwt: "h.p.s",
        realUserID: "562139107990159360",
      }),
    );
    expect(credential.jwt).toBe("h.p.s");
    expect(credential.cookie).toBe("k=v");
    expect(credential.userId).toBe("562139107990159360");
  });

  // The upstream keys its query envelope on the harvester's `realUserID`, which
  // is a different number from the JWT's `user.id`, and answers 401 for both
  // that value and an absent one. A credential that cannot supply it is
  // unusable, so it is refused here instead of dispatched into a bare 401.
  test("rejects a credential that carries no account id", () => {
    expect(() => parseMinimaxCredential(JSON.stringify({ jwt: "h.p.s", cookie: "k=v" }))).toThrow(
      GatewayError,
    );
  });

  test("rejects a bare secret, which cannot carry the account id", () => {
    expect(() => parseMinimaxCredential("h.p.s")).toThrow(GatewayError);
  });

  test("rejects a JSON credential without a jwt", () => {
    expect(() => parseMinimaxCredential('{"cookie":"k=v"}')).toThrow(GatewayError);
  });

  test("rejects malformed JSON rather than dispatching it", () => {
    expect(() => parseMinimaxCredential('{"jwt":')).toThrow(GatewayError);
  });

  // The upstream reads `user_id` off the query string and rejects the whole
  // call with 401 when it does not name the account, so the envelope must carry
  // the credential's id rather than anything read out of the token.
  test("keys the query envelope on the credential's account id", () => {
    const credential = parseMinimaxCredential(
      JSON.stringify({ jwt: "h.p.s", cookie: "", realUserID: "562139107990159360" }),
    );
    const params = new URLSearchParams(buildMinimaxParams(credential));
    expect(params.get("user_id")).toBe("562139107990159360");
    expect(params.get("token")).toBe("h.p.s");
  });
});

describe("MiniMax Agent stream transform", () => {
  test("maps an agent chunk to a content delta", () => {
    const events = transformMinimaxPayload(
      JSON.stringify({ type: 6, agent_message_chunk: { msg_content: "hello" } }),
      freshState(),
    );
    expect(textOf(events)).toBe("hello");
  });

  test("does not repeat the final envelope after chunks already streamed", () => {
    const state = freshState();
    transformMinimaxPayload(
      JSON.stringify({ type: 6, agent_message_chunk: { msg_content: "hello" } }),
      state,
    );
    const final = transformMinimaxPayload(
      JSON.stringify({ type: 2, agent_message: { role: "assistant", msg_content: "hello", finish_reason: "stop" } }),
      state,
    );
    expect(textOf(final)).toBe("");
    expect(state.finishReason).toBe("stop");
  });

  test("falls back to the final envelope when the upstream streamed no chunks", () => {
    const final = transformMinimaxPayload(
      JSON.stringify({ type: 2, agent_message: { role: "assistant", msg_content: "hello", finish_reason: "stop" } }),
      freshState(),
    );
    expect(textOf(final)).toBe("hello");
  });

  test("ends the stream with a terminal event carrying upstream usage", async () => {
    const sse = [
      'data:{"type":6,"agent_message_chunk":{"msg_content":"hi"}}',
      "",
      'data:{"type":2,"agent_message":{"role":"assistant","finish_reason":"stop","usage":{"input_tokens":12,"output_tokens":3,"cache_read":4}}}',
      "",
    ].join("\n");
    const events = await collect(transformMinimaxSse(streamOf(sse), new AbortController().signal, MODEL));
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("terminal");
    if (terminal?.type !== "terminal") throw new Error("no terminal event");
    expect(terminal.stop_reason).toBe("stop");
    expect(terminal.usage?.input_tokens).toBe(12);
    expect(terminal.usage?.output_tokens).toBe(3);
  });
});

describe("MiniMax Agent dispatch", () => {
  function stagedFetch(overrides: { readonly message?: () => Response } = {}) {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
      if (url.includes("/api/v1/agent?")) {
        return jsonResponse({ agents: [{ name: "447799983186038", role: "mavis" }] });
      }
      if (url.includes("/session?")) return jsonResponse({ session_id: "sess-1" });
      if (overrides.message) return overrides.message();
      return new Response(
        `data:${JSON.stringify({ type: 6, agent_message_chunk: { msg_content: "SMOKE_OK" } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  function dispatchWith(fetchImpl: typeof fetch, wireFamily: ProviderDispatchTarget["wire_family"] = "chat") {
    return createMinimaxAdapter({ fetch: fetchImpl }).dispatch(
      requestWithEffort("low"),
      candidateFor(wireFamily),
      contextFor(JSON.stringify({ jwt: "h.p.s", cookie: "k=v", realUserID: "562139107990159360" })),
    );
  }

  test("runs the agent list, session create, then message handshake in order", async () => {
    const { fetchImpl, calls } = stagedFetch();
    const events = await collect(dispatchWith(fetchImpl));
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["GET", "POST", "POST"]);
    expect(calls[0]).toContain("/api/v1/agent");
    expect(calls[1]).toContain("/session");
    expect(calls[2]).toContain("/api/v1/session/sess-1/message");
    expect(textOf(events)).toBe("SMOKE_OK");
  });

  test("surfaces an upstream message rejection as a gateway error", async () => {
    const { fetchImpl } = stagedFetch({
      message: () => jsonResponse({ error: { message: "nope" } }, 500),
    });
    await expect(collect(dispatchWith(fetchImpl))).rejects.toBeInstanceOf(GatewayError);
  });

  test("rejects a wire family the agent endpoint cannot serve", async () => {
    const { fetchImpl } = stagedFetch();
    await expect(collect(dispatchWith(fetchImpl, "responses"))).rejects.toBeInstanceOf(GatewayError);
  });
});
