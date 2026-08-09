import { ApiError } from "./api";

/** Converts unknown request failures into safe user-facing copy. */
export function getErrorMessage(error: unknown, fallback = "Request failed"): string {
  if (error instanceof ApiError && error.message.trim().length > 0) return error.message;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return fallback;
}
