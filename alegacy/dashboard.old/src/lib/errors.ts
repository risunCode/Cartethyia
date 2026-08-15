import { ApiError, sanitizeErrorMessage } from "./api";

/** Converts unknown request failures into safe user-facing copy. */
export function getErrorMessage(error: unknown, fallback = "Request failed"): string {
  if (error instanceof ApiError) return sanitizeErrorMessage(error.message, fallback);
  if (error instanceof Error) return sanitizeErrorMessage(error.message, fallback);
  return fallback;
}
