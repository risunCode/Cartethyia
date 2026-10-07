/**
 * Provider-specific knobs config.ts formerly owned: Kimi OAuth/quota hosts,
 * the GitHub Enterprise domain for the Copilot device login, and the OAuth
 * callback URL builders built on the public origin.
 */

import { CONFIG_SPEC, readRequired, readText } from "./spec";

/** Reads and normalizes the public OAuth origin. */
export function requirePublicOrigin(): string {
  return readRequired("CARTETHYIA_PUBLIC_ORIGIN", CONFIG_SPEC.CARTETHYIA_PUBLIC_ORIGIN).replace(
    /\/+$/,
    "",
  );
}

/** Builds the fixed OAuth callback URL for a provider id. */
export function oauthCallbackUrl(providerId: string): string {
  return `${requirePublicOrigin()}/console/api/providers/${providerId}/oauth/callback`;
}

/**
 * Browser-authorize redirect URI for a provider.
 *
 * Browser OAuth always advertises the loopback callback
 * `http://127.0.0.1:59653/callback` — the URI Codex registers with its
 * authorization server. The console callback stays the exchange
 * endpoint: the dashboard dialog pastes the loopback landing URL back and
 * the server exchanges the code against the same loopback URI.
 */
export function browserAuthorizeRedirectUri(): string {
  return "http://127.0.0.1:59653/callback";
}

/**
 * Kimi OAuth origin host, overridable for self-hosted or regional gateways.
 * Read here so the only literal `process.env` for this value stays in config.
 */
export function resolveKimiOAuthHost(): string {
  return readText("CARTETHYIA_KIMI_OAUTH_HOST", CONFIG_SPEC.CARTETHYIA_KIMI_OAUTH_HOST);
}

/** Reads Kimi Code's quota/billing base URL. */
export function resolveKimiQuotaBaseUrl(): string {
  return readText(
    "CARTETHYIA_KIMI_QUOTA_BASE_URL",
    CONFIG_SPEC.CARTETHYIA_KIMI_QUOTA_BASE_URL,
  );
}

/**
 * GitHub Enterprise domain for the Copilot device login, or `""` for github.com.
 *
 * Normalized to a bare hostname: an operator may reasonably paste a URL, and
 * every call site interpolates this into `https://<domain>/...`, so a scheme or
 * trailing slash left in place would produce an unreachable URL.
 */
export function resolveGithubEnterpriseDomain(): string {
  const raw = readText(
    "CARTETHYIA_GITHUB_ENTERPRISE_DOMAIN",
    CONFIG_SPEC.CARTETHYIA_GITHUB_ENTERPRISE_DOMAIN,
  ).trim();
  if (raw.length === 0) return "";
  try {
    const url = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    return url.hostname;
  } catch {
    return "";
  }
}
