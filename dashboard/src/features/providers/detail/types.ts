import type { ModelPricing } from "../formatters";
import type { OAuthFlowCapabilities } from "../oauth-connect-actions";
import type { AccountHealthSnapshot, RouteHealthSnapshot } from "../../../lib/account-health";

export interface ModelMetadataResponse {
  context?: { inputTokens?: number | null; outputTokens?: number | null };
  categories?: readonly ("vision" | "text" | "reasoning")[];
  pricing?: { inputPerMillion?: number | null; outputPerMillion?: number | null };
  source?: "catalog" | "custom";
}

export type ProviderCapability = "chat" | "media" | "websearch";

export const PROVIDER_CAPABILITY_LABELS: Record<ProviderCapability, string> = {
  chat: "Chat",
  media: "Image / Video",
  websearch: "Web Search",
};

export interface ModelEntry {
  id: string;
  reasoning?: boolean;
  vision?: boolean;
  websearch?: boolean;
  capabilities: Record<ProviderCapability, boolean>;
  contextWindow?: number;
  maxOutputTokens?: number;
  enabled: boolean;
  source: "built-in" | "manual" | "imported";
  pricing?: ModelPricing;
}

export interface QuotaSnapshot {
  readonly status: "unknown" | "refreshing" | "ready" | "error";
  readonly remaining: number | null;
  readonly limit: number | null;
  readonly resetsAt: string | null;
  readonly error: string | null;
}

export interface AccountEntry {
  id: string;
  provider: string;
  name: string;
  credentialKind: string;
  credentialHint: string;
  active: boolean;
  health: (AccountHealthSnapshot & { occurredAt?: string | null; lastRefreshAt?: string | null }) | null;
  quota?: QuotaSnapshot | null;
}

export interface RouteState {
  id?: string;
  routeId?: string;
  name?: string;
  label?: string;
  health?: RouteHealthSnapshot | null;
  status?: RouteHealthSnapshot["status"];
  failureKind?: string | null;
  statusCode?: number | null;
  sanitizedMessage?: string | null;
  retryAt?: string | null;
}

export interface RouteSwitchEvent {
  scope?: "account" | "proxy";
  previousRouteId?: string | null;
  replacementRouteId?: string | null;
  reason?: string;
  occurredAt?: string;
}

export interface ProviderDetail {
  id: string;
  name: string;
  icon: string;
  authKind: "none" | "session" | "oauth" | "api-key";
  supportsOAuth: boolean;
  oauthFlows: OAuthFlowCapabilities;
  credentialKinds: string[];
  authHint: string;
  credentialUrl: string | null;
  accountCredentialKind: string;
  prefix: string;
  models: ModelEntry[];
  accounts: AccountEntry[];
  routing: {
    strategy: "priority" | "round-robin";
    stickyLimit: number;
    useStickyLimit: boolean;
    proxyRouteId: string | null;
  };
  modelManagement: { canAddModels: boolean; canFetchModels: boolean };
  status: "ok" | "warn";
  usageToday: number | null;
  health: RouteHealthSnapshot | null;
  proxyHealth: RouteHealthSnapshot | null;
  failedRoute: RouteState | null;
  replacementRoute: RouteState | null;
  switchEvent: RouteSwitchEvent | null;
}

export interface ProviderDetailResponse {
  id: string;
  name: string;
  protocol: string;
  credentialKind: "api_key" | "oauth" | "session" | "manual" | "none";
  credentialKinds?: Array<"api_key" | "oauth" | "session" | "manual" | "none">;
  credentialUrl?: string | null;
  oauthFlows?: OAuthFlowCapabilities;
  enabled: boolean;
  models: Array<{
    modelId: string;
    displayName?: string;
    enabled: boolean;
    source?: "built-in" | "manual" | "imported";
    capabilities?: { chat?: boolean; media?: boolean; websearch?: boolean };
    metadata?: ModelMetadataResponse;
  }>;
  modelManagement?: { canAddModels: boolean; canFetchModels: boolean };
  accounts: Array<{
    id: string;
    provider?: string;
    providerId?: string;
    name?: string;
    label?: string;
    credentialKind?: string;
    credentialHint?: string | null;
    enabled?: boolean;
    active?: boolean;
    health?: unknown;
    quota?: unknown;
  }>;
  routing?: {
    strategy?: "priority" | "round-robin";
    stickyLimit?: number;
    useStickyLimit?: boolean;
    proxyRouteId?: string | null;
  };
}

export interface OAuthLoginStart {
  sessionId: string;
  provider: string;
  status: string;
  authorizationUrl: string;
  redirectUri: string;
  instructions: string;
  expiresAt: number;
  userCode?: string | null;
  verificationUri?: string | null;
  intervalSeconds?: number | null;
  flow?: "browser" | "device";
}

export interface OAuthLoginStatus {
  sessionId: string;
  provider: string;
  status: string;
  accountId?: string;
  errorKind?: string;
  errorMessage?: string;
  expiresAt: number;
}

export interface TestResult {
  resolveOk: boolean;
  latencyMs: number;
  firstVisibleTextMs?: number;
  ok: boolean;
  error?: string;
}
