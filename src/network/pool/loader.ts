/**
 * Real dispatch-time counterpart to the console CRUD store: reads one
 * `network_pools` row and decrypts its credential, in the exact shape
 * `PoolAgentResolver` expects to actually route a request through it. A
 * disabled, deleted, or tenant-mismatched pool is reported to the request
 * owner instead of silently changing the egress policy.
 */
import { eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { networkPools } from "../../persistence/schema";
import { decryptCredentialToString } from "../../security/crypto";
import { deriveKind, PoolBindingError, splitEndpointConfig } from "./agent";
import type { NetworkPoolLoader, NetworkPoolRow } from "./resolver";

export class DrizzleNetworkPoolLoader implements NetworkPoolLoader {
  constructor(private readonly db: CartethyiaDatabase) {}

  async load(poolId: string): Promise<NetworkPoolRow | undefined> {
    const rows = await this.db
      .select()
      .from(networkPools)
      .where(eq(networkPools.id, poolId))
      .limit(1);
    const row = rows[0];
    if (!row || row.status === "disabled") return undefined;
    if (!row.tenantId) return undefined;
    const raw = (row.endpointConfig ?? {}) as Record<string, unknown>;
    const { endpoint, rest } = splitEndpointConfig(raw);
    const kind = deriveKind(row.kind, endpoint ?? "");
    // HTTP/HTTPS/SOCKS5 pools dial `endpoint` directly and cannot be built
    // without one. Pools carry their transport config in the opaque keys.
    const requiresEndpoint = kind === "http" || kind === "https" || kind === "socks5";
    if (requiresEndpoint && !endpoint) return undefined;
    let credential: string | undefined;
    if (row.credentialCiphertext) {
      try {
        credential = decryptCredentialToString(row.credentialCiphertext);
      } catch {
        throw new PoolBindingError(
          `network pool ${row.id} credential cannot be decrypted; re-save the pool credential`,
        );
      }
    }
    return {
      id: row.id,
      kind,
      endpoint: endpoint ?? "",
      tenantId: row.tenantId,
      ...(credential ? { credential } : {}),
      ...(Object.keys(rest).length > 0 ? { config: rest } : {}),
    };
  }
}

