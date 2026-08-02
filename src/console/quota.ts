export type AccountQuotaWindowKind = "session" | "daily" | "weekly" | "monthly" | "other";

export interface AccountQuotaWindow {
  kind: AccountQuotaWindowKind;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
}

export interface AccountQuota {
  plan: string | null;
  windows: AccountQuotaWindow[];
  fetchedAt: string;
  error: string | null;
}
