export type OAuthImportProvider = "openai-codex" | "anthropic-oauth" | "cline" | "grok-cli" | "google-antigravity";

export interface OAuthCredentialBundle {
  version: 1;
  provider: OAuthImportProvider;
  refreshToken: string;
  accessToken: string;
  accessExpiresAt: number;
  accountId?: string;
  orgId?: string;
  orgName?: string;
  email?: string;
  planType?: string;
  projectId?: string;
  userId?: string;
  authorizedAt: number;
  updatedAt: number;
}

export type OAuthImportResult =
  | { ok: true; credential: string; bundle: OAuthCredentialBundle }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    if (isRecord(value.data)) return value.data;
    if (typeof value.data === "string") {
      const nested: unknown = JSON.parse(value.data);
      return isRecord(nested) ? nested : null;
    }
    return value;
  } catch {
    return null;
  }
}

export function importOAuthCredential(provider: OAuthImportProvider, raw: string): OAuthImportResult {
  const input = parseObject(raw.trim());
  if (!input) return { ok: false, reason: "OAuth import expects an exported account JSON object" };

  const now = Date.now();
  const existingProvider = nonEmptyString(input.provider);
  const existingRefresh = nonEmptyString(input.refreshToken);
  if (input.version === 1 && existingProvider && existingRefresh) {
    if (existingProvider !== provider) return { ok: false, reason: `credential belongs to provider '${existingProvider}'` };
    const accessToken = nonEmptyString(input.accessToken);
    const accessExpiresAt = typeof input.accessExpiresAt === "number" ? input.accessExpiresAt : undefined;
    if (!accessToken || accessExpiresAt === undefined) return { ok: false, reason: "OAuth bundle must include accessToken and accessExpiresAt" };
    const bundle: OAuthCredentialBundle = {
      version: 1,
      provider,
      refreshToken: existingRefresh,
      accessToken,
      accessExpiresAt,
      ...(nonEmptyString(input.accountId) ? { accountId: input.accountId as string } : {}),
      ...(nonEmptyString(input.orgId) ? { orgId: input.orgId as string } : {}),
      ...(nonEmptyString(input.orgName) ? { orgName: input.orgName as string } : {}),
      ...(nonEmptyString(input.email) ? { email: input.email as string } : {}),
      ...(nonEmptyString(input.planType) ? { planType: input.planType as string } : {}),
      ...(nonEmptyString(input.projectId) ? { projectId: input.projectId as string } : {}),
      ...(nonEmptyString(input.userId) ? { userId: input.userId as string } : {}),
      authorizedAt: typeof input.authorizedAt === "number" ? input.authorizedAt : now,
      updatedAt: now,
    };
    return { ok: true, credential: JSON.stringify(bundle), bundle };
  }

  const accessToken = nonEmptyString(input.access) ?? nonEmptyString(input.accessToken);
  const refreshToken = nonEmptyString(input.refresh) ?? nonEmptyString(input.refreshToken);
  const rawExpiry = input.expires ?? input.expiresAt;
  const accessExpiresAt = typeof rawExpiry === "number" ? rawExpiry : typeof rawExpiry === "string" ? Date.parse(rawExpiry) : undefined;
  if (!accessToken || !refreshToken || accessExpiresAt === undefined || !Number.isFinite(accessExpiresAt)) {
    return { ok: false, reason: "OAuth JSON must include accessToken/access, refreshToken/refresh, and expiresAt/expires" };
  }
  const bundle: OAuthCredentialBundle = {
    version: 1,
    provider,
    refreshToken,
    accessToken,
    accessExpiresAt,
    ...(nonEmptyString(input.accountId) ? { accountId: input.accountId as string } : {}),
    ...(nonEmptyString(input.orgId) ? { orgId: input.orgId as string } : {}),
    ...(nonEmptyString(input.orgName) ? { orgName: input.orgName as string } : {}),
    ...(nonEmptyString(input.email) ? { email: input.email as string } : {}),
    ...(nonEmptyString(input.planType) ? { planType: input.planType as string } : {}),
    authorizedAt: typeof input.authorizedAt === "number" ? input.authorizedAt : now,
    updatedAt: now,
  };
  return { ok: true, credential: JSON.stringify(bundle), bundle };
}
