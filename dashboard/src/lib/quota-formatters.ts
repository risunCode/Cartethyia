export interface QuotaBarTone {
  bar: string;
  text: string;
}

export function formatResetDistance(value: string | null, recurring = true): string {
  if (!value) return "";
  const remaining = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return recurring ? "Resetting soon" : "Expired";
  const prefix = recurring ? "Resets in" : "Expires in";
  const totalMinutes = Math.ceil(remaining / 60_000);
  if (totalMinutes < 60) return `${prefix} ${totalMinutes}mins`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${prefix} ${totalHours}h${minutes > 0 ? ` ${minutes}mins` : ""}`;
  const totalDays = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const suffix = `${hours > 0 ? ` ${hours}h` : ""}${minutes > 0 ? ` ${minutes}mins` : ""}`;
  if (totalDays >= 365) {
    const years = Math.floor(totalDays / 365);
    const days = totalDays % 365;
    return `${prefix} ${years}y${days > 0 ? ` ${days}d` : ""}${suffix}`;
  }
  if (totalDays >= 30) {
    const months = Math.floor(totalDays / 30);
    const days = totalDays % 30;
    return `${prefix} ${months}mo${days > 0 ? ` ${days}d` : ""}${suffix}`;
  }
  return `${prefix} ${totalDays}d${suffix}`;
}

export function formatQuotaWindowLabel(label: string): string {
  const match = /^(\d+)\s*hour$/i.exec(label.trim());
  if (!match) return label;
  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours <= 0) return label;
  if (hours === 24) return "Daily";
  if (hours === 168) return "Weekly";
  if (hours === 720) return "Monthly";
  if (hours === 8760) return "Yearly";
  if (hours >= 8760)
    return `${Math.floor(hours / 8760)}y${hours % 8760 > 0 ? ` ${Math.floor((hours % 8760) / 24)}d` : ""}`;
  if (hours >= 720)
    return `${Math.floor(hours / 720)}mo${hours % 720 > 0 ? ` ${Math.floor((hours % 720) / 24)}d` : ""}`;
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24 > 0 ? ` ${hours % 24}h` : ""}`;
  return `${hours}h`;
}

export function formatQuotaRefresh(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `Last refreshed: ${date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
    : "";
}

export function friendlyQuotaError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (
    lower.includes("invalidated") ||
    lower.includes("reauthorization") ||
    lower.includes("refresh token revoked")
  )
    return "OAuth account invalidated — re-login required";
  // Collectorless providers never refresh, so this backend string should no
  // longer surface — but a stale cached error may still carry it. Keep the
  // mapping as a safety net, not a state the UI can reach fresh.
  if (lower.includes("endpoint is not available") || lower === "not available")
    return "Quota tracking is not supported for this provider";
  if (lower.includes("overloaded") || lower.includes("capacity") || lower.includes("temporarily unavailable"))
    return "Provider capacity unavailable — retry after the indicated time";
  if (lower.includes("usage limit") || lower.includes("quota") || lower.includes("rate limit"))
    return "Quota exhausted or rate limited — wait for reset";
  if (lower.includes("http 500") || lower.includes("internal server error"))
    return "Provider temporarily unavailable — retry in a moment";
  if (lower.includes("http 429") || lower.includes("too many requests"))
    return "Rate limited — slow down requests";
  if (lower.includes("http 401") || lower.includes("unauthorized") || lower.includes("invalid"))
    return "Credential expired — re-login or refresh token";
  if (lower.includes("http 403") || lower.includes("forbidden"))
    return "Access denied — check account permissions";
  if (lower.includes("http 402") || lower.includes("payment"))
    return "Payment required — top up account balance";
  if (lower.includes("connect") || lower.includes("network") || lower.includes("timeout"))
    return "Network error — check connection and retry";
  return "Provider error — inspect account health details";
}

export function quotaBarTone(remaining: number | null): QuotaBarTone {
  if (remaining === null) return { bar: "var(--text-tertiary)", text: "var(--text-tertiary)" };
  if (remaining < 20) return { bar: "var(--red)", text: "var(--red)" };
  if (remaining < 50) return { bar: "var(--orange)", text: "var(--orange)" };
  return { bar: "var(--green)", text: "var(--green)" };
}

export interface AccountIdentity {
  readonly primary: string;
  readonly secondary: string | null;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isTokenHint(value: string): boolean {
  return value.startsWith("eyJ") || value.startsWith("sk-") || value.startsWith("…");
}

export function displayAccountHint(hint: string, name: string): string {
  if (hint.startsWith("eyJ") || hint === "—") return name;
  return hint;
}

/** Credential-kind labels are categories, not identities — never displayed. */
const NON_IDENTITY_HINTS: ReadonlySet<string> = new Set(["oauth", "api_key", "none"]);

export function accountIdentity(hint: string, name: string): AccountIdentity {
  const fallbackName = name.trim() || "Unnamed account";
  const normalizedHint = displayAccountHint(hint, fallbackName).trim();
  const usableHint =
    normalizedHint && normalizedHint !== "—" && !NON_IDENTITY_HINTS.has(normalizedHint.toLowerCase())
      ? normalizedHint
      : null;
  const email =
    [usableHint, fallbackName].find((value): value is string => value !== null && isEmail(value)) ??
    null;
  if (email !== null) {
    const secondary =
      [fallbackName, usableHint].find(
        (value): value is string => value !== null && value !== email && !isTokenHint(value),
      ) ?? null;
    return { primary: email, secondary };
  }
  const secondary =
    usableHint !== null && usableHint !== fallbackName && !isTokenHint(usableHint)
      ? usableHint
      : null;
  return { primary: fallbackName, secondary };
}
