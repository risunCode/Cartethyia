import type { ApiErrorShape } from "./api";

/** Narrows an unknown thrown value to the console client's error envelope. */
function isApiErrorShape(error: unknown): error is ApiErrorShape {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  );
}

/** Converts unknown request failures into safe user-facing copy. */
export function getErrorMessage(error: unknown, fallback = "Request failed"): string {
  if (isApiErrorShape(error) && error.message.trim().length > 0) return error.message;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return fallback;
}

/** Maps public-share error codes to safe user-facing copy; unknown codes yield undefined. */
export function shareCodeMessage(code: string | undefined): string | undefined {
  if (code === "link_expired_or_used") return "This enrollment link has expired or has already been used.";
  if (code === "key_unavailable") return "The shared access template is no longer available.";
  if (code === "link_not_found") return "This enrollment link is unavailable.";
  return undefined;
}

/** Writes text to the browser clipboard and reports origin or permission failures. */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
