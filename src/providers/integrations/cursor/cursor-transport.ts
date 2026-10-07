/**
 * Cursor's transport: Connect-RPC over HTTP/2.
 *
 * Two shapes, and mixing them gets a bodyless 415 back. Unary calls
 * (`GetUsableModels`, token refresh) send `application/proto` with a bare
 * body. The turn itself is `application/connect+proto`: a bidirectional
 * stream of 5-byte frames. `fetch` cannot hold a bidirectional stream open,
 * so the turn opens `node:http2` directly.
 */
import { randomUUID } from "node:crypto";
import * as http2 from "node:http2";
import { gunzipSync } from "node:zlib";
import { CONNECT_COMPRESSED_FLAG, CONNECT_END_STREAM_FLAG, consumeConnectFrames, frameConnectMessage } from "../shared/connect";

export const CURSOR_BASE_URL = "https://api2.cursor.sh" as const;
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run" as const;
export const CURSOR_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels" as const;

const FRAME_CAP_BYTES = 8 * 1024 * 1024;

export interface CursorCallContext {
  readonly token: string;
  readonly clientVersion: string;
  readonly signal?: AbortSignal;
}

export interface UnaryResult {
  readonly status: number;
  readonly payload: Uint8Array | undefined;
  readonly error: string | undefined;
}

/** One unary Connect call. The body is the bare message, no frame envelope. */
export async function unaryCall(
  path: string,
  body: Uint8Array,
  context: CursorCallContext,
  timeoutMs = 20_000,
): Promise<UnaryResult> {
  const client = http2.connect(CURSOR_BASE_URL);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`${path} timed out`)), timeoutMs);
      const finish = (error: Error): void => {
        clearTimeout(timer);
        reject(error);
      };
      client.on("error", finish);
      const req = client.request({
        ":method": "POST",
        ":path": path,
        "content-type": "application/proto",
        "connect-protocol-version": "1",
        authorization: `Bearer ${context.token}`,
        "x-ghost-mode": "true",
        "x-cursor-client-version": context.clientVersion,
        "x-cursor-client-type": "cli",
        "x-request-id": randomUUID(),
      });
      const chunks: Buffer[] = [];
      let status = 0;
      req.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("error", finish);
      req.on("end", () => {
        clearTimeout(timer);
        const payload = Buffer.concat(chunks);
        resolve(status === 200
          ? { status, payload, error: undefined }
          : { status, payload: undefined, error: `HTTP ${status}: ${payload.toString("utf8").slice(0, 300)}` });
      });
      req.end(Buffer.from(body));
    });
  } finally {
    client.close();
  }
}

export interface BidiStream {
  send(payload: Uint8Array): void;
  /** Frames as they arrive. Ends when the stream ends or errors. */
  frames(): AsyncGenerator<ConnectFrame>;
  close(): void;
}

export interface ConnectFrame {
  readonly flags: number;
  readonly payload: Uint8Array;
  /** Set when the frame carried the end-of-stream trailer. */
  readonly end: boolean;
}

export interface BidiOptions extends CursorCallContext {
  readonly timeoutMs: number;
  /** Native tool names the model may see. Empty hides all of them. */
  readonly allowedNativeTools: readonly string[];
}

/** Open the bidirectional `Run` stream. The caller sends the first frame. */
export function openRunStream(options: BidiOptions): BidiStream {
  const client = http2.connect(CURSOR_BASE_URL);
  const headers: Record<string, string> = {
    ":method": "POST",
    ":path": CURSOR_RUN_PATH,
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    te: "trailers",
    authorization: `Bearer ${options.token}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": options.clientVersion,
    "x-cursor-client-type": "cli",
    "x-request-id": randomUUID(),
  };
  if (options.allowedNativeTools.length > 0) {
    headers["x-cursor-agent-allowed-tools"] = options.allowedNativeTools.join(",");
  }
  const req = client.request(headers);

  const queue: ConnectFrame[] = [];
  let notify: (() => void) | undefined;
  let ended = false;
  let failure: Error | undefined;
  const wake = (): void => {
    const pending = notify;
    notify = undefined;
    pending?.();
  };
  const fail = (error: Error): void => {
    if (ended) return;
    ended = true;
    failure = error;
    wake();
  };

  let buffer = Buffer.alloc(0);
  req.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    let consumed;
    try {
      consumed = consumeConnectFrames(buffer, { maxPayloadBytes: FRAME_CAP_BYTES });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    buffer = Buffer.from(consumed.rest);
    for (const frame of consumed.frames) {
      const compressed = (frame.flags & CONNECT_COMPRESSED_FLAG) !== 0;
      const payload = compressed ? gunzipSync(frame.payload) : frame.payload;
      queue.push({ flags: frame.flags, payload, end: (frame.flags & CONNECT_END_STREAM_FLAG) !== 0 });
    }
    if (queue.length > 0) wake();
  });
  req.on("error", (error) => fail(error));
  req.on("end", () => {
    ended = true;
    wake();
  });

  const timer = setTimeout(() => fail(new Error("upstream timeout")), options.timeoutMs);
  options.signal?.addEventListener("abort", () => fail(new Error("client aborted")), { once: true });

  return {
    send(payload) {
      if (!req.closed && !req.destroyed) req.write(frameConnectMessage(payload));
    },
    async *frames() {
      try {
        for (;;) {
          if (queue.length === 0) {
            if (failure) throw failure;
            if (ended) return;
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            continue;
          }
          const frame = queue.shift()!;
          yield frame;
          if (frame.end) return;
        }
      } finally {
        clearTimeout(timer);
        req.close();
        client.close();
      }
    },
    close() {
      clearTimeout(timer);
      req.close();
      client.close();
    },
  };
}
