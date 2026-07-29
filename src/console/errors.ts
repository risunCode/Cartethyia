/** Uniform console API error envelope: { error: { code, message } }. */

export type ConsoleErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal";

export function consoleError(code: ConsoleErrorCode, message: string): { error: { code: ConsoleErrorCode; message: string } } {
  return { error: { code, message } };
}
