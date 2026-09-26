// Cursor adapter dispatch: the Connect+protobuf run loop against a real local
// HTTP/2 server. The adapter's transport is injectable through `baseUrl`, so
// these tests exercise the production code path end to end — a genuine cleartext
// HTTP/2 peer on 127.0.0.1, not a stub of the adapter's own socket handling.
import { describe, expect, test } from "bun:test";
import * as http2 from "node:http2";
import { gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { AgentClientMessage, AgentServerMessage } from "../../../../src/providers/integrations/cursor/generated/agent_pb";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  RequestContextArgsSchema,
  ShellArgsSchema,
} from "../../../../src/providers/integrations/cursor/generated/agent_pb";
import {
  CONNECT_COMPRESSED_FLAG,
  CONNECT_END_STREAM_FLAG,
  consumeConnectFrames,
  frameConnectMessage,
} from "../../../../src/providers/integrations/connect";
import { CURSOR_RUN_PATH, createCursorAdapter } from "../../../../src/providers/integrations/cursor/cursor";
import type { CanonicalEvent, CanonicalRequest, ToolDefinition } from "../../../../src/transport/canonical-model";
import type {
  CredentialKind,
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../../../src/providers/provider-registry";
import { collect } from "../../../helpers/sse-fixtures";

const encoder = new TextEncoder();

// --- upstream server -------------------------------------------------------

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string;
  readonly chunks: readonly Buffer[];
}

interface RunServer {
  readonly baseUrl: string;
  readonly requests: readonly CapturedRequest[];
  close(): Promise<void>;
}

/**
 * A real HTTP/2 peer that answers `/agent.v1.AgentService/Run` with `handler`.
 * `chunks` records the raw request bytes so a test can decode what the adapter
 * actually put on the wire.
 */
async function startRunServer(
  handler: (stream: http2.Http2Stream) => void,
): Promise<RunServer> {
  const server = http2.createServer();
  const requests: CapturedRequest[] = [];
  const streams: http2.Http2Stream[] = [];
  const sessions: http2.ServerHttp2Session[] = [];
  server.on("session", (session) => {
    sessions.push(session);
  });
  server.on("stream", (stream, headers) => {
    streams.push(stream);
    const chunks: Buffer[] = [];
    requests.push({
      method: String(headers[":method"] ?? ""),
      path: String(headers[":path"] ?? ""),
      authorization: String(headers["authorization"] ?? ""),
      chunks,
    });
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    handler(stream);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      for (const stream of streams) stream.destroy();
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/**
 * A `baseUrl` that is known to refuse connections. Used by the validation tests
 * so a credential/tool check that stops rejecting fails loudly on the socket
 * attempt instead of silently reaching the real Cursor host.
 */
async function closedPortUrl(): Promise<string> {
  const server = http2.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${port}`;
}

// --- server frames ---------------------------------------------------------

function serverFrame(message: AgentServerMessage): Buffer {
  return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function textDeltaFrame(text: string): Buffer {
  return serverFrame(
    create(AgentServerMessageSchema, {
      message: { case: "interactionUpdate", value: { message: { case: "textDelta", value: { text } } } },
    }),
  );
}

function turnEndedFrame(): Buffer {
  return serverFrame(
    create(AgentServerMessageSchema, {
      message: { case: "interactionUpdate", value: { message: { case: "turnEnded", value: {} } } },
    }),
  );
}

function requestContextExecFrame(id: number, execId: string): Buffer {
  return serverFrame(
    create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, {
          id,
          execId,
          message: { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) },
        }),
      },
    }),
  );
}

function shellExecFrame(id: number, execId: string): Buffer {
  return serverFrame(
    create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, {
          id,
          execId,
          message: { case: "shellArgs", value: create(ShellArgsSchema, {}) },
        }),
      },
    }),
  );
}

function trailerFrame(value: unknown, flags = CONNECT_END_STREAM_FLAG): Buffer {
  return frameConnectMessage(encoder.encode(JSON.stringify(value)), flags);
}

/** Every client frame the adapter wrote, envelope stripped. */
function decodeClientFrames(chunks: readonly Buffer[]): AgentClientMessage[] {
  const { frames } = consumeConnectFrames(Buffer.concat(chunks));
  return frames
    .filter((frame) => (frame.flags & CONNECT_END_STREAM_FLAG) === 0)
    .map((frame) => fromBinary(AgentClientMessageSchema, frame.payload));
}

// --- canonical fixtures ----------------------------------------------------

function request(
  overrides: {
    readonly text?: string;
    readonly model?: string;
    readonly tools?: readonly ToolDefinition[];
  } = {},
): CanonicalRequest {
  return {
    model: overrides.model ?? "default",
    messages: [
      { role: "user", content: [{ kind: "text", text: overrides.text ?? "hello" }] },
    ],
    ...(overrides.tools === undefined ? {} : { tools: overrides.tools }),
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  };
}

function candidate(overrides: { readonly model_id?: string } = {}): ProviderDispatchTarget {
  return {
    provider_id: "cursor",
    model_id: overrides.model_id ?? "default",
    // Inert for this adapter: it frames its own Connect protocol and ignores
    // the family, but the dispatch target requires one of the canonical three.
    wire_family: "chat",
    endpoint_path: CURSOR_RUN_PATH,
    capabilities: {},
  };
}

function context(
  options: {
    readonly credential_kind?: CredentialKind;
    readonly secret?: Uint8Array | undefined;
    readonly abort_signal?: AbortSignal;
  } = {},
): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "cursor",
      credential_kind: options.credential_kind ?? "oauth",
      secret: "secret" in options ? options.secret : encoder.encode("tok-abc"),
    },
    deadline: Date.now() + 10_000,
    abort_signal: options.abort_signal ?? new AbortController().signal,
  };
}

interface GatewayFailure {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly origin: string;
}

/** The typed gateway failure a dispatch rejects with, or a fixture error. */
async function rejectionOf(iterable: AsyncIterable<CanonicalEvent>): Promise<GatewayFailure> {
  let failure: unknown = null;
  try {
    await collect(iterable);
  } catch (error) {
    failure = error;
  }
  if (failure === null) throw new Error("expected the dispatch to reject");
  const { code, status, message, origin } = failure as Partial<GatewayFailure>;
  if (
    typeof code !== "string" ||
    typeof status !== "number" ||
    typeof message !== "string" ||
    typeof origin !== "string"
  ) {
    throw new Error(`expected a GatewayError, received ${String(failure)}`);
  }
  return { code, status, message, origin };
}

describe("Cursor dispatch credential and request validation", () => {
  test("rejects an API-key credential before any connection is opened", async () => {
    const baseUrl = await closedPortUrl();
    const adapter = createCursorAdapter({ baseUrl });
    const failure = await rejectionOf(
      adapter.dispatch(request(), candidate(), context({ credential_kind: "api_key" })),
    );
    expect(failure).toEqual({
      code: "invalid_request",
      status: 400,
      message: "Cursor adapter requires an OAuth credential",
      origin: "cartethyia",
    });
  });

  test("rejects a credential with no secret", async () => {
    const baseUrl = await closedPortUrl();
    const adapter = createCursorAdapter({ baseUrl });
    const failure = await rejectionOf(
      adapter.dispatch(request(), candidate(), context({ secret: undefined })),
    );
    expect(failure).toEqual({
      code: "authentication_failed",
      status: 401,
      message: "Missing Cursor access token",
      origin: "cartethyia",
    });
  });

  test("rejects a zero-length secret", async () => {
    const baseUrl = await closedPortUrl();
    const adapter = createCursorAdapter({ baseUrl });
    const failure = await rejectionOf(
      adapter.dispatch(request(), candidate(), context({ secret: new Uint8Array(0) })),
    );
    expect(failure).toEqual({
      code: "authentication_failed",
      status: 401,
      message: "Missing Cursor access token",
      origin: "cartethyia",
    });
  });

  test("rejects a whitespace-only secret as an empty access token", async () => {
    const baseUrl = await closedPortUrl();
    const adapter = createCursorAdapter({ baseUrl });
    const failure = await rejectionOf(
      adapter.dispatch(request(), candidate(), context({ secret: encoder.encode("   ") })),
    );
    expect(failure).toEqual({
      code: "authentication_failed",
      status: 401,
      message: "Empty Cursor access token",
      origin: "cartethyia",
    });
  });

  test("rejects tool calls as an unsupported capability", async () => {
    const baseUrl = await closedPortUrl();
    const adapter = createCursorAdapter({ baseUrl });
    const failure = await rejectionOf(
      adapter.dispatch(
        request({ tools: [{ name: "search", jsonSchema: { type: "object" } }] }),
        candidate(),
        context(),
      ),
    );
    expect(failure).toEqual({
      code: "capability_unsupported",
      status: 400,
      message: "Cursor adapter does not support tool calls yet",
      origin: "cartethyia",
    });
  });
});

describe("Cursor dispatch over the Connect transport", () => {
  test("streams text deltas and completes the turn", async () => {
    const server = await startRunServer((stream) => {
      stream.write(textDeltaFrame("hello"));
      stream.write(turnEndedFrame());
      stream.write(trailerFrame({}));
      stream.end();
    });
    try {
      const adapter = createCursorAdapter({ baseUrl: server.baseUrl });
      const events = await collect(adapter.dispatch(request(), candidate(), context()));
      expect(events).toEqual([
        { type: "response_start", sequence_number: 0, model: "default" },
        { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "hello" } },
        { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "stop" },
      ]);

      const seen = server.requests[0];
      if (seen === undefined) throw new Error("expected the adapter to open one stream");
      expect(seen.method).toBe("POST");
      expect(seen.path).toBe(CURSOR_RUN_PATH);
      expect(seen.authorization).toBe("Bearer tok-abc");

      const run = decodeClientFrames(seen.chunks).find(
        (message) => message.message.case === "runRequest",
      );
      if (run?.message.case !== "runRequest") throw new Error("expected a runRequest frame");
      const action = run.message.value.action;
      if (action?.action.case !== "userMessageAction") throw new Error("expected a userMessageAction");
      expect(run.message.value.requestedModel?.modelId).toBe("default");
      expect(action.action.value.userMessage?.text).toBe("hello");
    } finally {
      await server.close();
    }
  });

  test("decompresses a gzipped server frame", async () => {
    const server = await startRunServer((stream) => {
      const compressed = gzipSync(
        toBinary(
          AgentServerMessageSchema,
          create(AgentServerMessageSchema, {
            message: {
              case: "interactionUpdate",
              value: { message: { case: "textDelta", value: { text: "zipped" } } },
            },
          }),
        ),
      );
      stream.write(frameConnectMessage(compressed, CONNECT_COMPRESSED_FLAG));
      stream.write(turnEndedFrame());
      stream.write(trailerFrame({}));
      stream.end();
    });
    try {
      const adapter = createCursorAdapter({ baseUrl: server.baseUrl });
      const events = await collect(adapter.dispatch(request(), candidate(), context()));
      expect(events.at(-2)).toMatchObject({
        type: "content_delta",
        content: { kind: "text", text: "zipped" },
      });
      expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete" });
    } finally {
      await server.close();
    }
  });

  test("answers a requestContextArgs exec with a requestContextResult", async () => {
    let replied = false;
    const server = await startRunServer((stream) => {
      stream.write(requestContextExecFrame(7, "exec-7"));
      let buffer = Buffer.alloc(0);
      stream.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const { frames } = consumeConnectFrames(buffer);
        const answered = frames.some(
          (frame) =>
            fromBinary(AgentClientMessageSchema, frame.payload).message.case === "execClientMessage",
        );
        if (!answered || replied) return;
        replied = true;
        stream.write(turnEndedFrame());
        stream.write(trailerFrame({}));
        stream.end();
      });
    });
    try {
      const adapter = createCursorAdapter({ baseUrl: server.baseUrl });
      const events = await collect(adapter.dispatch(request(), candidate(), context()));
      expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete" });

      const seen = server.requests[0];
      if (seen === undefined) throw new Error("expected the adapter to open one stream");
      const reply = decodeClientFrames(seen.chunks).find(
        (message) => message.message.case === "execClientMessage",
      );
      if (reply?.message.case !== "execClientMessage") {
        throw new Error("expected an execClientMessage frame");
      }
      expect(reply.message.value.id).toBe(7);
      expect(reply.message.value.execId).toBe("exec-7");
      expect(reply.message.value.message.case).toBe("requestContextResult");
    } finally {
      await server.close();
    }
  });

  test("rejects an unsupported exec operation as an upstream platform error", async () => {
    const server = await startRunServer((stream) => {
      stream.write(shellExecFrame(9, "exec-9"));
      stream.write(trailerFrame({}));
      stream.end();
    });
    try {
      const adapter = createCursorAdapter({ baseUrl: server.baseUrl });
      const failure = await rejectionOf(adapter.dispatch(request(), candidate(), context()));
      expect(failure).toEqual({
        code: "platform_unavailable",
        status: 502,
        message: 'Cursor requested unsupported exec operation "shellArgs"',
        origin: "upstream",
      });
    } finally {
      await server.close();
    }
  });

  test("maps an end-of-stream trailer error to an upstream platform error", async () => {
    const server = await startRunServer((stream) => {
      stream.write(trailerFrame({ error: { code: "internal", message: "boom" } }));
      stream.end();
    });
    try {
      const adapter = createCursorAdapter({ baseUrl: server.baseUrl });
      const failure = await rejectionOf(adapter.dispatch(request(), candidate(), context()));
      expect(failure).toEqual({
        code: "platform_unavailable",
        status: 502,
        message: "Cursor error internal: boom",
        origin: "upstream",
      });
    } finally {
      await server.close();
    }
  });

  test("fails when the stream ends before turn completion", async () => {
    const server = await startRunServer((stream) => {
      stream.write(textDeltaFrame("partial"));
      stream.write(trailerFrame({}));
      stream.end();
    });
    try {
      const adapter = createCursorAdapter({ baseUrl: server.baseUrl });
      const failure = await rejectionOf(adapter.dispatch(request(), candidate(), context()));
      expect(failure).toEqual({
        code: "transport_unavailable",
        status: 502,
        message: "Cursor response ended before turn completion",
        origin: "upstream",
      });
    } finally {
      await server.close();
    }
  });

  test("reports a client cancellation as transport_closed", async () => {
    const controller = new AbortController();
    const server = await startRunServer((stream) => {
      stream.write(textDeltaFrame("partial"));
      setTimeout(() => controller.abort(), 50);
    });
    try {
      const adapter = createCursorAdapter({ baseUrl: server.baseUrl });
      const failure = await rejectionOf(
        adapter.dispatch(request(), candidate(), context({ abort_signal: controller.signal })),
      );
      expect(failure).toEqual({
        code: "transport_closed",
        status: 499,
        message: "request was cancelled",
        origin: "cartethyia",
      });
    } finally {
      await server.close();
    }
  });

  test("rejects a signal that was already aborted before connecting", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = createCursorAdapter({ baseUrl: await closedPortUrl() });
    const failure = await rejectionOf(
      adapter.dispatch(request(), candidate(), context({ abort_signal: controller.signal })),
    );
    expect(failure).toEqual({
      code: "transport_unavailable",
      status: 502,
      message: "Cursor request aborted",
      origin: "cartethyia",
    });
  });

  test("completes a probe turn on idle text without a turnEnded frame", async () => {
    const server = await startRunServer((stream) => {
      stream.write(textDeltaFrame("hello"));
      stream.write(textDeltaFrame(" again"));
      // Deliberately never sends turnEnded: a probe turn ends on idle.
    });
    try {
      const adapter = createCursorAdapter({ baseUrl: server.baseUrl });
      const events = await collect(
        adapter.dispatch(request({ text: "Be honest about your identity" }), candidate(), context()),
      );
      expect(events.map((event) => event.type)).toEqual([
        "response_start",
        "content_delta",
        "content_delta",
        "terminal",
      ]);
      expect(events.at(-1)).toMatchObject({
        type: "terminal",
        state: "complete",
        stop_reason: "stop",
      });
    } finally {
      await server.close();
    }
  });

  test("still completes normally when a probe turn does send turnEnded", async () => {
    const server = await startRunServer((stream) => {
      stream.write(textDeltaFrame("hello"));
      stream.write(turnEndedFrame());
      stream.write(trailerFrame({}));
      stream.end();
    });
    try {
      const adapter = createCursorAdapter({ baseUrl: server.baseUrl });
      const events = await collect(
        adapter.dispatch(request({ text: "Be honest about your identity" }), candidate(), context()),
      );
      expect(events.map((event) => event.type)).toEqual([
        "response_start",
        "content_delta",
        "terminal",
      ]);
      expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete" });
    } finally {
      await server.close();
    }
  });

  test("sends a client heartbeat while the turn is open", async () => {
    let heartbeatSeen = false;
    const server = await startRunServer((stream) => {
      stream.write(textDeltaFrame("hello"));
      let buffer = Buffer.alloc(0);
      stream.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const { frames } = consumeConnectFrames(buffer);
        const heartbeat = frames.some(
          (frame) =>
            fromBinary(AgentClientMessageSchema, frame.payload).message.case === "clientHeartbeat",
        );
        if (!heartbeat || heartbeatSeen) return;
        heartbeatSeen = true;
        stream.write(turnEndedFrame());
        stream.write(trailerFrame({}));
        stream.end();
      });
    });
    try {
      // A short interval keeps this a unit test: what is asserted is the frame
      // shape, and waiting the production 5s cadence would only test the clock.
      const adapter = createCursorAdapter({
        baseUrl: server.baseUrl,
        heartbeatIntervalMs: 25,
      });
      const events = await collect(adapter.dispatch(request(), candidate(), context()));
      expect(heartbeatSeen).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete" });
    } finally {
      await server.close();
    }
  });

  test("falls back to the request model when the target model id is empty", async () => {
    const server = await startRunServer((stream) => {
      stream.write(turnEndedFrame());
      stream.write(trailerFrame({}));
      stream.end();
    });
    try {
      const adapter = createCursorAdapter({ baseUrl: server.baseUrl });
      const events = await collect(
        adapter.dispatch(
          request({ model: "composer-2.5" }),
          candidate({ model_id: "" }),
          context(),
        ),
      );
      expect(events[0]).toMatchObject({ type: "response_start", model: "composer-2.5" });

      const seen = server.requests[0];
      if (seen === undefined) throw new Error("expected the adapter to open one stream");
      const run = decodeClientFrames(seen.chunks).find(
        (message) => message.message.case === "runRequest",
      );
      if (run?.message.case !== "runRequest") throw new Error("expected a runRequest frame");
      expect(run.message.value.requestedModel?.modelId).toBe("composer-2.5");
      expect(run.message.value.modelDetails?.modelId).toBe("composer-2.5");
    } finally {
      await server.close();
    }
  });

  test("surfaces a connection failure as the transport error", async () => {
    const adapter = createCursorAdapter({ baseUrl: await closedPortUrl() });
    let failure: unknown = null;
    try {
      await collect(adapter.dispatch(request(), candidate(), context()));
    } catch (error) {
      failure = error;
    }
    if (!(failure instanceof Error)) throw new Error("expected a transport error");
    expect((failure as { code?: string }).code).toBe("ECONNREFUSED");
  });

  test("registers under the cursor provider id", () => {
    expect(createCursorAdapter().provider_id).toBe("cursor");
  });
});
