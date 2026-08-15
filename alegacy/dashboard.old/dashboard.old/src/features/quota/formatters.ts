export interface QuotaBarTone {
  bar: string;
  text: string;
}

export function formatResetDistance(value: string | null): string {
  if (!value) return "";
  const remaining = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "Resetting soon";
  const totalMinutes = Math.ceil(remaining / 60_000);
  if (totalMinutes < 60) return `Resets in ${totalMinutes}mins`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `Resets in ${totalHours}h${minutes > 0 ? ` ${minutes}mins` : ""}`;
  const totalDays = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const suffix = `${hours > 0 ? ` ${hours}h` : ""}${minutes > 0 ? ` ${minutes}mins` : ""}`;
  if (totalDays >= 365) {
    const years = Math.floor(totalDays / 365);
    const days = totalDays % 365;
    return `Resets in ${years}y${days > 0 ? ` ${days}d` : ""}${suffix}`;
  }
  if (totalDays >= 30) {
    const months = Math.floor(totalDays / 30);
    const days = totalDays % 30;
    return `Resets in ${months}mo${days > 0 ? ` ${days}d` : ""}${suffix}`;
  }
  return `Resets in ${totalDays}d${suffix}`;
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
  if (hours >= 8760) return `${Math.floor(hours / 8760)}y${hours % 8760 > 0 ? ` ${Math.floor((hours % 8760) / 24)}d` : ""}`;
  if (hours >= 720) return `${Math.floor(hours / 720)}mo${hours % 720 > 0 ? ` ${Math.floor((hours % 720) / 24)}d` : ""}`;
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24 > 0 ? ` ${hours % 24}h` : ""}`;
  return `${hours}h`;
}

export function formatQuotaRefresh(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `Last refreshed: ${date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : "";
}

export function friendlyQuotaError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes("invalidated") || lower.includes("reauthorization") || lower.includes("refresh token revoked")) return "OAuth account invalidated — re-login required";
  if (lower.includes("not available") || lower.includes("endpoint is not available")) return "Quota tracking is not supported for this provider";
  if (lower.includes("usage limit") || lower.includes("quota") || lower.includes("rate limit")) return "Quota exhausted — wait for reset or upgrade plan";
  if (lower.includes("http 500") || lower.includes("internal server error")) return "Provider temporarily unavailable — retry in a moment";
  if (lower.includes("http 429") || lower.includes("too many requests")) return "Rate limited — slow down requests";
  if (lower.includes("http 401") || lower.includes("unauthorized") || lower.includes("invalid")) return "Credential expired — re-login or refresh token";
  if (lower.includes("http 403") || lower.includes("forbidden")) return "Access denied — check account permissions";
  if (lower.includes("http 402") || lower.includes("payment")) return "Payment required — top up account balance";
  if (lower.includes("connect") || lower.includes("network") || lower.includes("timeout")) return "Network error — check connection and retry";
  return raw;
}

export function quotaBarTone(remaining: number | null): QuotaBarTone {
  if (remaining === null) return { bar: "bg-[var(--text-3)]", text: "text-[var(--text-3)]" };
  if (remaining < 20) return { bar: "bg-[var(--red)]", text: "text-[var(--red)]" };
  if (remaining < 50) return { bar: "bg-[var(--yellow)]", text: "text-[var(--yellow)]" };
  return { bar: "bg-[var(--green)]", text: "text-[var(--green)]" };
}
