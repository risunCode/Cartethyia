
// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

export type ConsoleErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "request_too_large"
  | "internal_error";

export interface ConsoleErrorBody {
  readonly error: {
    readonly type: "error";
    readonly code: ConsoleErrorCode;
    readonly message: string;
    readonly request_id: string;
  };
}

/** Stable console error envelope (dashboard `ApiErrorShape`-compatible). */
export function consoleError(code: ConsoleErrorCode, message: string, requestId?: string): ConsoleErrorBody {
  return { error: { type: "error", code, message, request_id: requestId ?? crypto.randomUUID() } };
}
