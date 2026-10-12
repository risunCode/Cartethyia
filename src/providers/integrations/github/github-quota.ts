/**
 * GitHub Copilot quota collector.
 *
 * Copilot usage is exposed by `/copilot_internal/user`, not the
 * `/copilot_internal/v2/token` endpoint that mints inference tokens. The usage
 * endpoint takes the long-lived GitHub OAuth token, so the credential envelope
 * carries it alongside the minted Copilot token.
 *
 * The response shape is not a documented contract, so every field is read
 * defensively and an unrecognized body yields an empty window list rather than
 * a fabricated percentage.
 */
import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { getJson, isoDate, number, percentWindow, quotaRecord, text } from "../../quota/quota-contracts";
import { resolveGithubEnterpriseDomain } from "../../../config/providers";
import { GITHUB_REQUEST_HEADERS, parseGithubCredential } from "./github-oauth";

/**
 * Reads quota windows from GitHub's Copilot usage response.
 */
export function parseGithubQuota(body: unknown): ProviderQuotaResult {
  const payload = quotaRecord(body);
  const plan =
    text(payload.copilot_plan) ??
    text(payload.access_type_sku) ??
    text(payload.sku) ??
    text(payload.plan);
  const windows: ProviderQuotaWindow[] = [];
  const reset = isoDate(payload.limited_user_reset_date) ?? isoDate(payload.quota_reset_date);
  const snapshots = quotaRecord(payload.quota_snapshots);
  const accountLabel = text(payload.login);
  const snapshotTypes = [
    { kind: "premium_interactions", label: "Premium Requests", accounting: "pooled" },
    { kind: "chat", label: "Chat Requests", accounting: "pooled" },
    { kind: "completions", label: "Completions", accounting: "independent" },
  ] as const;
  for (const { kind, label, accounting } of snapshotTypes) {
    const snapshot = quotaRecord(snapshots[kind]);
    if (Object.keys(snapshot).length === 0) continue;
    const entitlement = number(snapshot.entitlement);
    const left = number(snapshot.remaining) ?? number(snapshot.quota_remaining);
    const percentRemaining = number(snapshot.percent_remaining);
    const usedPercent =
      percentRemaining !== null
        ? 100 - percentRemaining
        : entitlement !== null && entitlement > 0 && left !== null
          ? ((entitlement - left) / entitlement) * 100
          : null;
    if (snapshot.unlimited === true) {
      windows.push(percentWindow(kind, label, null, reset, null, null, accounting));
      continue;
    }
    if (entitlement !== null && entitlement <= 0 && (left === null || left <= 0)) continue;
    if (usedPercent === null) continue;
    let usedCredits: number | null = null;
    if (entitlement !== null && left !== null) {
      usedCredits = Math.max(0, Math.min(entitlement, entitlement - left));
    } else if (entitlement !== null) {
      usedCredits = Math.max(0, Math.min(entitlement, (entitlement * usedPercent) / 100));
    }
    windows.push(
      percentWindow(
        kind,
        label,
        usedPercent,
        reset,
        usedCredits,
        entitlement,
        accounting,
      ),
    );
  }
  if (windows.length > 0) {
    return {
      source: "github",
      plan,
      windows,
      error: null,
      ...(accountLabel === null ? {} : { accountLabel }),
    };
  }

  const quotas = quotaRecord(payload.limited_user_quotas ?? payload.monthly_quotas);
  const remaining = quotaRecord(payload.limited_user_quotas_remaining);
  for (const [kind, rawLimit] of Object.entries(quotas)) {
    const limit = number(rawLimit);
    if (limit === null || limit <= 0) continue;
    const left = number(remaining?.[kind]);
    const used = left === null ? null : Math.max(0, limit - left);
    const accounting =
      kind === "chat" || kind === "premium_interactions" ? "pooled" : "independent";
    windows.push(
      percentWindow(
        kind,
        kind.charAt(0).toUpperCase() + kind.slice(1),
        used === null ? null : (used / limit) * 100,
        reset,
        used,
        limit,
        accounting,
      ),
    );
  }
  return { source: "github", plan, windows, error: null };
}

export async function fetchGithubQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const parsed = parseGithubCredential(credential);
  // The usage endpoint authenticates with the GitHub token. When the envelope
  // predates that field, the minted token is sent instead and the upstream
  // answers with an auth error that surfaces honestly rather than as a
  // fabricated window.
  const token = parsed.github ?? parsed.access;
  const domain = resolveGithubEnterpriseDomain() || "github.com";
  const body = await getJson(
    `https://api.${domain}/copilot_internal/user`,
    {
      authorization: `Bearer ${token}`,
      ...GITHUB_REQUEST_HEADERS,
    },
    fetcher,
  );
  return parseGithubQuota(body);
}
