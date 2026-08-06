import type { ProviderCallError } from "../domain/contracts";
import { publicErrorBody } from "../domain/contracts";
import type { ProviderOutput } from "../domain/contracts";
import type { PresentedProxyResponse, ResponseWriter } from "../domain/contracts";
import { isTerminalEvent, type StreamEvent } from "../domain/contracts";
import type { StreamLifecycleController } from "./recovery";

/**
 * Response presentation: turns `ProviderOutput` (or a typed failure) into a
 * `PresentedProxyResponse` without owning HTTP. Non-Stream output is
 * presented as a JSON body; Stream output as an event iterable with a
 * content-type default. Errors are presented as exactly one pre-header
 * `PublicErrorBody` or, after headers commit, as exactly one post-header
 * terminal stream error event — never as a second response and never as a
 * fabricated empty success.
 */

type NonStreamOutput = Extract<ProviderOutput, { readonly mode: "non_stream" }>;
type StreamOutput = Extract<ProviderOutput, { readonly mode: "stream" }>;

const DEFAULT_STREAM_CONTENT_TYPE = "text/event-stream";

export interface WriteStreamOptions {
  /** Lifecycle marked `headersCommitted` at presentation; recovery consults it. */
  readonly lifecycle?: StreamLifecycleController;
  /** Content type for the stream body; defaults to text/event-stream. */
  readonly contentType?: string;
}

/** Presents a Non-Stream provider output as a JSON response body. */
export function writeNonStreamResponse(output: NonStreamOutput, _requestId: string): PresentedProxyResponse {
  return {
    status: 200,
    headers: new Headers({ "content-type": "application/json", "cache-control": "no-store" }),
    body: { mode: "json", value: output.body },
  };
}

/**
 * Presents a Stream provider output as an event iterable. Presentation is
 * the header-commit point for recovery: once presented, the response mode is
 * fixed and no retry can replace the response.
 */
export function writeStreamResponse(output: StreamOutput, _requestId: string, options: WriteStreamOptions = {}): PresentedProxyResponse {
  options.lifecycle?.markHeadersCommitted();
  return {
    status: 200,
    headers: new Headers({
      "content-type": options.contentType ?? DEFAULT_STREAM_CONTENT_TYPE,
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    }),
    body: { mode: "stream", events: output.events },
  };
}

/** Mode dispatcher matching the application `ResponseWriter` contract. */
export function writeResponse(output: ProviderOutput, requestId: string, options: WriteStreamOptions = {}): PresentedProxyResponse {
  if (output.mode === "non_stream") return writeNonStreamResponse(output, requestId);
  return writeStreamResponse(output, requestId, options);
}

/** Application-contract response writer bound to fixed presentation options. */
export function createResponseWriter(options: WriteStreamOptions = {}): ResponseWriter {
  return {
    write: (output: ProviderOutput, requestId: string): PresentedProxyResponse => writeResponse(output, requestId, options),
  };
}

/**
 * Pre-header failure presentation: one sanitized `PublicErrorBody` with the
 * request identifier, status from the typed error (502 when unknown). No raw
 * upstream bodies, credentials, or internal detail ever reach this envelope.
 */
export function writeErrorResponse(error: ProviderCallError, requestId: string): PresentedProxyResponse {
  return {
    status: error.statusCode ?? 502,
    headers: new Headers({ "content-type": "application/json", "cache-control": "no-store" }),
    body: { mode: "json", value: publicErrorBody(error, requestId) },
  };
}

/**
 * The one post-header terminal stream error event. Surface encoders map it
 * to their protocol-valid error frame; it is emitted at most once per stream.
 */
export function terminalErrorEvent(): StreamEvent {
  return { type: "message_stop", reason: "error" };
}

export interface AppendTerminalErrorOptions {
  /** Receives the underlying stream failure (e.g. telemetry) without rethrowing it to the client. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Wraps a presented event stream so a mid-stream failure terminates with
 * exactly one terminal error event and a clean end — no second response is
 * started. If the stream already terminated (or fails after a terminal
 * event), nothing further is emitted.
 */
export async function* appendTerminalError(events: AsyncIterable<StreamEvent>, options: AppendTerminalErrorOptions = {}): AsyncGenerator<StreamEvent> {
  let terminal = false;
  try {
    for await (const event of events) {
      if (isTerminalEvent(event)) terminal = true;
      yield event;
    }
  } catch (error) {
    options.onError?.(error);
  }
  if (!terminal) yield terminalErrorEvent();
}
