import type { ProviderQuotaResult } from "./types";
import { unsupportedQuota } from "./shared";

/** Cursor has no supported quota endpoint; keep that result provider-specific. */
export function fetchCursorQuota(): ProviderQuotaResult {
  return unsupportedQuota("cursor");
}
