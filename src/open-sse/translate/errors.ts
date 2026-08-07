import { sanitizeMessage, deriveErrorSource, type ApplicationErrorKind, type ProviderCallError } from "../../domain/contracts";

/** Typed failure raised while encoding or decoding a protocol payload. */
export class ProtocolCodecError extends Error {
  readonly kind: ApplicationErrorKind;
  readonly statusCode: number | null;
  readonly retryable: boolean;
  readonly routeScope: "account" | "proxy" | "provider" | null;
  readonly retryAt: string | null;

  constructor(options: {
    readonly kind: ApplicationErrorKind;
    readonly message: string;
    readonly statusCode?: number | null;
    readonly retryable?: boolean;
    readonly routeScope?: "account" | "proxy" | "provider" | null;
    readonly retryAt?: string | null;
  }) {
    super(options.message);
    this.name = "ProtocolCodecError";
    this.kind = options.kind;
    this.statusCode = options.statusCode ?? null;
    this.retryable = options.retryable ?? false;
    this.routeScope = options.routeScope ?? "provider";
    this.retryAt = options.retryAt ?? null;
  }

  toProviderCallError(sanitizedMessage: string): ProviderCallError {
    return {
      statusCode: this.statusCode,
      kind: this.kind,
      retryable: this.retryable,
      routeScope: this.routeScope,
      source: deriveErrorSource(this.kind, this.routeScope),
      sanitizedMessage,
      retryAt: this.retryAt,
    };
  }
}

export type StreamDecodeKind = "provider_protocol_error" | "stream_truncated" | "client_aborted";

/**
 * Typed failure for decode-level problems: malformed UTF-8, over-long lines,
 * malformed NDJSON records, caller abort, and streams that end without a
 * terminal event. Structurally compatible with the application `ProviderCallError`
 * via {@link StreamDecodeError.toProviderCallError}; never retryable (stream
 * truncation is terminal by default).
 */
export class StreamDecodeError extends Error {
  readonly kind: StreamDecodeKind;
  readonly statusCode: number | null;
  readonly retryable: false;
  readonly routeScope: "provider" | null;
  readonly retryAt: null;

  constructor(kind: StreamDecodeKind, message: string, statusCode: number | null = null) {
    super(message);
    this.name = "StreamDecodeError";
    this.kind = kind;
    this.statusCode = statusCode;
    this.retryable = false;
    this.routeScope = kind === "client_aborted" ? null : "provider";
    this.retryAt = null;
  }

  toProviderCallError(): ProviderCallError {
    return {
      statusCode: this.statusCode,
      kind: this.kind,
      retryable: this.retryable,
      routeScope: this.routeScope,
      source: deriveErrorSource(this.kind, this.routeScope),
      sanitizedMessage: sanitizeMessage(this.message),
      retryAt: this.retryAt,
    };
  }
}
