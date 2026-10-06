// Control-plane credential selection: picks the first usable upstream
// credential alternative in operator order.

import { GatewayError } from "../protocol/gateway-error";
import { unwrapProviderToken, type TokenEnvelope } from "./credential-envelope";
import type { CredentialKind, ProviderId, ResolvedCredential } from "./contracts";

/** One control-plane credential alternative, ordered by operator preference. */
export interface CredentialAlternative {
  readonly provider_id: ProviderId;
  readonly account_id?: string | undefined;
  readonly credential_kind: CredentialKind;
  /** Secret supplied by the control plane, never read from a client request. */
  readonly secret?: string | Uint8Array | undefined;
  /** Explicit envelope label for provider-issued token normalization. */
  readonly token_envelope?: TokenEnvelope | undefined;
  /** Health/expiry/quota result from the account control plane. */
  readonly usable?: boolean | undefined;
  /** Non-secret per-account upstream auth configuration; see `ResolvedCredential`. */
  readonly auth_state?: Readonly<Record<string, unknown>> | undefined;
}

/** Result of ordered credential selection, with no client-auth fields. */
export interface CredentialResolution {
  readonly credential: ResolvedCredential;
  readonly alternative_index: number;
}

/**
 * Selects the first usable upstream credential alternative in operator order.
 * Public Cartethyia authentication is intentionally absent from this interface.
 */
export class CredentialResolver {
  /**
   * Resolves an ordered list, including a genuine no-credential route.
   * @throws GatewayError when all alternatives are unavailable.
   */
  resolve(
    providerId: ProviderId,
    alternatives: readonly CredentialAlternative[],
  ): CredentialResolution {
    for (const [alternativeIndex, alternative] of alternatives.entries()) {
      if (alternative.provider_id !== providerId) continue;
      if (alternative.usable === false) continue;
      if (alternative.credential_kind === "none") {
        return {
          credential: {
            provider_id: providerId,
            ...(alternative.account_id === undefined ? {} : { account_id: alternative.account_id }),
            credential_kind: "none",
            ...(alternative.auth_state === undefined ? {} : { auth_state: alternative.auth_state }),
          },
          alternative_index: alternativeIndex,
        };
      }
      const secret = resolveSecret(alternative.secret, alternative.token_envelope);
      if (secret === undefined) continue;
      return {
        credential: {
          provider_id: providerId,
          ...(alternative.account_id === undefined ? {} : { account_id: alternative.account_id }),
          credential_kind: alternative.credential_kind,
          secret,
          ...(alternative.auth_state === undefined ? {} : { auth_state: alternative.auth_state }),
        },
        alternative_index: alternativeIndex,
      };
    }

    throw new GatewayError(
      "invalid_request",
      401,
      "No usable upstream credential is configured for the selected provider",
      { provider_id: providerId },
    );
  }
}

function resolveSecret(
  value: CredentialAlternative["secret"],
  envelope: TokenEnvelope | undefined,
): Uint8Array | undefined {
  if (value === undefined) return undefined;
  const unwrapped = unwrapProviderToken(value, envelope);
  return unwrapped.length === 0 ? undefined : unwrapped;
}
