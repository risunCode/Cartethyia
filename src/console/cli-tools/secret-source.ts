import { and, eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { apiKeys } from "../../persistence/schema";
import { decryptCredentialToString, hashSecret } from "../../security/crypto";
import type { CliToolSecretSource, ResolvedApiKeySecret } from "./service";

/**
 * Reads a tenant's own API keys back to their plaintext secret.
 *
 * This exists because the CLI config a tool needs contains a real bearer
 * token, and the operator should not have to paste it by hand: the console
 * already stores a recoverable AES-256-GCM copy in `api_keys.key_encrypted`
 * for exactly this kind of server-side handoff (the public share page and the
 * Studio default-key flow read the same column).
 *
 * Two properties keep this from widening the secret's exposure:
 * - The plaintext never leaves the server. The console route that uses it
 *   builds a config body and returns that; there is no "show me the key"
 *   response.
 * - Every lookup is tenant-scoped, so one tenant's console session can never
 *   resolve another tenant's key.
 */
export class DrizzleCliToolSecretSource implements CliToolSecretSource {
  constructor(private readonly db: CartethyiaDatabase) {}

  async resolveSecret(tenantId: string, keyId: string): Promise<ResolvedApiKeySecret | undefined> {
    const rows = await this.db
      .select({
        id: apiKeys.id,
        label: apiKeys.label,
        keyPrefix: apiKeys.keyPrefix,
        keyEncrypted: apiKeys.keyEncrypted,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)))
      .limit(1);
    return decryptRow(rows[0]);
  }

  /**
   * Fallback for a caller that only has the pasted secret: hash it the same
   * way authentication does and match the stored hash, then read the
   * recoverable copy. Keys created before `key_encrypted` existed match no
   * recoverable copy and correctly resolve to `undefined`.
   */
  async resolveSecretByValue(
    tenantId: string,
    secret: string,
  ): Promise<ResolvedApiKeySecret | undefined> {
    const rows = await this.db
      .select({
        id: apiKeys.id,
        label: apiKeys.label,
        keyPrefix: apiKeys.keyPrefix,
        keyEncrypted: apiKeys.keyEncrypted,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.keyHash, hashSecret(secret))))
      .limit(1);
    return decryptRow(rows[0]);
  }
}

function decryptRow(
  row:
    | {
        id: string;
        label: string;
        keyPrefix: string | null;
        keyEncrypted: Buffer | null;
        revokedAt: Date | null;
      }
    | undefined,
): ResolvedApiKeySecret | undefined {
  if (!row || row.revokedAt !== null) return undefined;
  if (row.keyEncrypted === null) return undefined;
  return {
    id: row.id,
    label: row.label,
    keyPrefix: row.keyPrefix,
    secret: decryptCredentialToString(row.keyEncrypted),
  };
}
