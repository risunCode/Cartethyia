import type { OAuthTokenRecord } from "../../application/auth/credentials";

export interface ProviderQuotaWindow {
  readonly kind: string;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetsAt: string | null;
  readonly used?: number | null;
  readonly limit?: number | null;
}

export interface ProviderQuotaResult {
  readonly source: string;
  readonly plan: string | null;
  readonly windows: readonly ProviderQuotaWindow[];
  readonly error: string | null;
}

export type FetchLike = typeof fetch;
export type OAuthQuotaToken = OAuthTokenRecord | undefined;
