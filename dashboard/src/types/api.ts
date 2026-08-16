/**
 * API response models for the Cartethyia dashboard.
 *
 * These interfaces describe the JSON shape returned by the daemon's
 * `/v2/dashboard/...` and `/console/auth/...` endpoints. Consumers should
 * import from this module instead of declaring ad-hoc types so the
 * dashboard surface stays aligned with the server contract.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ApiUser {
  id: string;
  username: string;
  email?: string;
  role: string;
  displayName?: string;
}

export interface PageInfo {
  total: number;
  hasMore: boolean;
  nextCursor?: string;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  refreshToken?: string;
  expiresAt?: number;
  user: ApiUser;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export interface RefreshTokenResponse {
  token: string;
  expiresAt?: number;
}

export interface LogoutRequest {
  refreshToken?: string;
}

export interface LogoutResponse {
  success: boolean;
}

// ---------------------------------------------------------------------------
// Overview / Summary
// ---------------------------------------------------------------------------

export interface SummaryMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  averageLatencyMs: number;
  uptimeSeconds: number;
}

export interface SummaryResponse {
  metrics: SummaryMetrics;
  activeProviders: number;
  errorRate: number;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export type UsageStatus = "success" | "error" | "cancelled";

export interface UsageEntry {
  id: string;
  timestamp: string;
  model: string;
  provider: string;
  surface: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  durationMs: number;
  status: UsageStatus;
  errorMessage?: string;
}

export interface UsageBucket {
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  requests: number;
}

export interface UsageAggregates {
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCost: number;
  byProvider: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
}

export interface UsageResponse extends PageInfo {
  entries: UsageEntry[];
  aggregates: UsageAggregates;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface ProviderSummary {
  id: string;
  name: string;
  enabled: boolean;
  healthy: boolean;
  modelCount: number;
  requestsLast24h: number;
  tokensLast24h: number;
  errorRateLast24h: number;
  averageLatencyMs: number;
  lastCheckedAt: string;
}

export interface ProvidersResponse extends PageInfo {
  providers: ProviderSummary[];
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

export type QuotaScope = "minute" | "hour" | "day" | "month";

export interface QuotaBucket {
  provider: string;
  scope: QuotaScope;
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface QuotaResponse {
  buckets: QuotaBucket[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Console Log
// ---------------------------------------------------------------------------

export type ConsoleLogLevel = "debug" | "info" | "warn" | "error";

export interface ConsoleHistoryEntry {
  id: string;
  timestamp: string;
  level: ConsoleLogLevel;
  source: string;
  message: string;
  requestId?: string;
  providerId?: string;
}

export interface ConsoleHistoryResponse extends PageInfo {
  entries: ConsoleHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type SettingsTheme = "light" | "dark" | "system";
export type SettingsNotificationChannel = "browser" | "email" | "webhook";

export interface SettingsNotifications {
  enabled: boolean;
  quotaThresholdPercent: number;
  channels: SettingsNotificationChannel[];
}

export interface SettingsResponse {
  theme: SettingsTheme;
  refreshIntervalMs: number;
  defaultProviderId: string | null;
  defaultModel: string | null;
  streamingEnabled: boolean;
  notifications: SettingsNotifications;
  shareDefaultExpiryHours: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

export type ShareVisibility = "public" | "private" | "password";

export interface ShareEntry {
  id: string;
  name: string;
  slug: string;
  url: string;
  resourcePath: string;
  visibility: ShareVisibility;
  createdAt: string;
  expiresAt: string | null;
  viewCount: number;
  createdBy: string;
}

export interface ShareResponse extends PageInfo {
  shares: ShareEntry[];
}
