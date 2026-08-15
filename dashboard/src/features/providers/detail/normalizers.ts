import type {
  AccountEntry,
  ProviderDetail,
  ProviderDetailResponse,
  QuotaSnapshot,
} from "./types";

function normalizeHealth(value: unknown): AccountEntry["health"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const status = raw.status;
  if (status !== "healthy" && status !== "refreshing" && status !== "error" && status !== "disabled" && status !== "reauthentication-required" && status !== "cooling_down") return null;
  const text = (candidate: unknown): string | null => typeof candidate === "string" && candidate.length <= 240 ? candidate : null;
  return {
    status,
    errorKind: text(raw.errorKind),
    failureKind: text(raw.failureKind),
    statusCode: typeof raw.statusCode === "number" ? raw.statusCode : null,
    sanitizedMessage: text(raw.sanitizedMessage),
    retryAt: text(raw.retryAt),
    ...(text(raw.occurredAt) ? { occurredAt: text(raw.occurredAt) } : {}),
    ...(text(raw.lastRefreshAt) ? { lastRefreshAt: text(raw.lastRefreshAt) } : {}),
  };
}

function normalizeQuota(value: unknown): QuotaSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const status = raw.status === "refreshing" || raw.status === "ready" || raw.status === "error" ? raw.status : "unknown";
  const numberValue = (candidate: unknown) => typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
  const stringValue = (candidate: unknown) => typeof candidate === "string" && candidate.length <= 240 ? candidate : null;
  return {
    status,
    remaining: numberValue(raw.remaining ?? raw.remainingPercent),
    limit: numberValue(raw.limit),
    resetsAt: stringValue(raw.resetsAt),
    error: stringValue(raw.error ?? raw.sanitizedError),
  };
}

/** Normalize an API account payload into the detail-page account shape. */
export function normalizeAccount(value: ProviderDetailResponse["accounts"][number], providerId: string): AccountEntry | null {
  if (typeof value.id !== "string" || !value.id) return null;
  const name = typeof value.name === "string" && value.name.trim()
    ? value.name.trim()
    : typeof value.label === "string" && value.label.trim()
      ? value.label.trim()
      : value.id;
  return {
    id: value.id,
    provider: value.providerId ?? value.provider ?? providerId,
    name,
    credentialKind: typeof value.credentialKind === "string" ? value.credentialKind : "unknown",
    credentialHint: typeof value.credentialHint === "string" && value.credentialHint.length <= 128 ? value.credentialHint : "",
    active: value.active ?? value.enabled === true,
    health: normalizeHealth(value.health),
    quota: normalizeQuota(value.quota),
  };
}

/** Normalize the provider detail response without changing API semantics. */
export function normalizeProviderDetail(response: ProviderDetailResponse): ProviderDetail {
  const authKind = response.credentialKind === "api_key" ? "api-key" : response.credentialKind === "manual" ? "none" : response.credentialKind;
  const supportsOAuth = response.credentialKinds?.includes("oauth") ?? response.credentialKind === "oauth";
  const oauthFlows = response.oauthFlows ?? { browser: false, device: false };
  return {
    id: response.id,
    name: response.name,
    icon: response.id,
    authKind,
    supportsOAuth,
    oauthFlows,
    credentialKinds: response.credentialKinds ?? [response.credentialKind],
    authHint: authKind === "none" ? "No authentication required" : supportsOAuth ? "Use an API key or connect an OAuth account." : "Add an account credential to route requests.",
    credentialUrl: response.credentialUrl ?? null,
    accountCredentialKind: response.credentialKinds?.includes("api_key") ? "api_key" : response.credentialKind,
    prefix: response.id,
    models: response.models.map((model) => {
      const metadata = model.metadata;
      const categories = metadata?.categories ?? [];
      const input = metadata?.pricing?.inputPerMillion ?? null;
      const output = metadata?.pricing?.outputPerMillion ?? null;
      return {
        id: model.modelId,
        enabled: model.enabled,
        source: model.source ?? (metadata?.source === "custom" ? "manual" : "built-in"),
        reasoning: categories.includes("reasoning"),
        vision: categories.includes("vision"),
        websearch: model.capabilities?.websearch === true,
        capabilities: {
          chat: model.capabilities?.chat === true,
          media: model.capabilities?.media === true,
          websearch: model.capabilities?.websearch === true,
        },
        contextWindow: metadata?.context?.inputTokens ?? undefined,
        maxOutputTokens: metadata?.context?.outputTokens ?? undefined,
        pricing: input !== null && output !== null ? { input, output } : undefined,
      };
    }),
    modelManagement: response.modelManagement ?? { canAddModels: true, canFetchModels: true },
    status: response.enabled && (authKind === "none" || response.accounts.some((account) => account.active ?? account.enabled === true)) ? "ok" : "warn",
    usageToday: null,
    accounts: response.accounts.flatMap((account) => {
      const item = normalizeAccount(account, response.id);
      return item ? [item] : [];
    }),
    routing: {
      strategy: response.routing?.strategy === "round-robin" ? "round-robin" : "priority",
      stickyLimit: response.routing?.stickyLimit ?? 1,
      useStickyLimit: response.routing?.useStickyLimit ?? false,
      proxyRouteId: response.routing?.proxyRouteId ?? null,
    },
    health: null,
    proxyHealth: null,
    failedRoute: null,
    replacementRoute: null,
    switchEvent: null,
  };
}
