/**
 * Provider metadata — single source of truth for prefix lookup, id
 * validation, and expected account credential kind (REQ-1).
 *
 * Previously `PREFIX_BY_PROVIDER` and `isProviderId()` were independently
 * re-derived in `console/api/overview.ts`, `console/api/providers.ts`, and
 * `console/api/combos.ts`; `CREDENTIAL_KIND_BY_PROVIDER` lived only in
 * `console/api/providers.ts` but as a hand-maintained table disconnected
 * from the provider registry itself.
 */

import { ADDED_PROVIDER_IDS, PROVIDER_PREFIXES, type AddedProviderId } from "./types";
import type { CredentialKind as AccountCredentialKind } from "../console/db/repos/accounts";

export function isProviderId(raw: string): raw is AddedProviderId {
  return (ADDED_PROVIDER_IDS as readonly string[]).includes(raw);
}

const PREFIX_BY_PROVIDER = Object.fromEntries(
  Object.entries(PROVIDER_PREFIXES).map(([prefix, id]) => [id, prefix])
) as Record<AddedProviderId, string>;

export function prefixOf(id: AddedProviderId): string {
  return PREFIX_BY_PROVIDER[id];
}

/**
 * Expected account credential storage kind per provider. This is distinct
 * from `Provider.display.authKind` (a 3-value UI grouping hint shared by
 * "session" providers with different storage forms, e.g. Devin's exchanged
 * session token vs Qoder's pasted PAT) — it cannot be mechanically derived
 * from `authKind` alone, so it stays an explicit table, now owned here only.
 */
const ACCOUNT_CREDENTIAL_KIND_BY_PROVIDER: Record<AddedProviderId, AccountCredentialKind> = {
  "opencode-free": "bearer",
  "opencode-zen": "bearer",
  agentrouter: "bearer",
  tpxiaomi: "bearer",
  commandcode: "bearer",
  kimchi: "bearer",
  devin: "session-token",
  qoder: "pat",
  custom: "bearer", // unused: custom providers resolve their own credential from custom_providers, not accounts
  cursor: "session-token",
  openai: "bearer",
  anthropic: "bearer",
  pgxiaomi: "bearer",
  openrouter: "bearer",
  ollama: "bearer",
  cerebras: "bearer",
  deepseek: "bearer",
  siliconflow: "bearer",
  mistral: "bearer",
  "opencode-go": "bearer",
};

export function accountCredentialKindOf(id: AddedProviderId): AccountCredentialKind {
  return ACCOUNT_CREDENTIAL_KIND_BY_PROVIDER[id];
}
