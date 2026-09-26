/**
 * Integration coverage for `OAuthRefreshService`:
 * single-flight refresh, lease-fenced persistence, and definitive/transient
 * failure classification against a real Postgres instance.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { applySqlMigrations } from "../../src/persistence/postgres";
import { fullSchema as schema } from "../../src/persistence/postgres";
import {
  providers,
  providerAccounts,
  providerOauthStates,
} from "../../src/persistence/schema";
import { setCredentialEncryptionKeyForTesting, encryptCredential } from "../../src/security/crypto";
import {
  OAuthRefreshService,
  loadDueOAuthAccounts,
  type OAuthTokenRefresher,
} from "../../src/providers/authentication/oauth-refresh-service";
import { dbDescribe, testDatabaseUrl } from "../helpers/db-gate";

let pool: Pool | undefined;
let db: NodePgDatabase<typeof schema> | undefined;

/**
 * Accounts this suite created, so cleanup removes exactly those.
 *
 * A table-wide `delete(providerAccounts)` is what this replaced: DB-gated
 * suites share one isolated database and run as concurrent Bun worker
 * processes, so wiping the whole table deleted other suites' fixtures
 * mid-test and surfaced as unrelated failures elsewhere. These rows carry a
 * null `tenant_id` — they are the shared catalog's accounts, not a tenant's —
 * so the recorded account ids are the only correct ownership boundary.
 */
const createdAccountIds: string[] = [];

function requireDb(): NodePgDatabase<typeof schema> {
  if (!db) throw new Error("test database was not initialized");
  return db;
}

async function insertAccount(opts: {
  providerId: string;
  refreshToken: string | undefined;
  expiresAt: Date | undefined;
  status?: "active" | "degraded" | "cooldown" | "disabled";
  cooldownUntil?: Date;
}): Promise<string> {
  await requireDb()
    .insert(providers)
    .values({ id: opts.providerId, enabled: true })
    .onConflictDoNothing();
  const [row] = await requireDb()
    .insert(providerAccounts)
    .values({
      providerId: opts.providerId,
      label: "test-account",
      credentialKind: "oauth",
      credentialCiphertext: encryptCredential("initial-access-token"),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.cooldownUntil ? { cooldownUntil: opts.cooldownUntil } : {}),
    })
    .returning({ id: providerAccounts.id });
  if (!row) throw new Error("failed to insert test account");
  createdAccountIds.push(row.id);
  if (opts.refreshToken !== undefined && opts.expiresAt !== undefined) {
    await requireDb()
      .insert(providerOauthStates)
      .values({
        providerAccountId: row.id,
        refreshCiphertext: encryptCredential(opts.refreshToken),
        expiresAt: opts.expiresAt,
      });
  }
  return row.id;
}

function fakeRefresher(result: OAuthTokenRefresher["refresh"]): OAuthTokenRefresher {
  return { refresh: result };
}

dbDescribe("OAuthRefreshService", () => {
  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 7));
    pool = new Pool({ connectionString: testDatabaseUrl, max: 4 });
    db = drizzle(pool, { schema });
    await applySqlMigrations(pool, resolve(import.meta.dir, "../../migrations"));
  });

  afterAll(async () => {
    setCredentialEncryptionKeyForTesting(undefined);
    if (pool) await pool.end();
  });

  afterEach(async () => {
    // Deleting the account cascades to its `provider_oauth_states` row, so the
    // lease and refresh state go with it. Scoped to this suite's ids: see
    // `createdAccountIds` for why a table-wide delete is not safe here.
    for (const id of createdAccountIds.splice(0)) {
      await requireDb().delete(providerAccounts).where(eq(providerAccounts.id, id));
    }
  });

  test("does not refresh a token that is not yet within the skew window", async () => {
    const accountId = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const service = new OAuthRefreshService(requireDb());
    let called = false;
    const refresher = fakeRefresher(async () => {
      called = true;
      throw new Error("should not be called");
    });
    const token = await service.ensureFreshAccessToken(accountId, refresher);
    expect(called).toBe(false);
    expect(token).toBe("initial-access-token");
  });

  test("refreshes and persists a token within the skew window", async () => {
    const accountId = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    const service = new OAuthRefreshService(requireDb());
    const refresher = fakeRefresher(async (refreshToken) => {
      expect(refreshToken).toBe("refresh-1");
      return {
        access: "new-access",
        refresh: "new-refresh",
        expiresAt: new Date(Date.now() + 3600_000),
      };
    });
    const token = await service.ensureFreshAccessToken(accountId, refresher);
    expect(token).toBe("new-access");

    const [account] = await requireDb()
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    const [oauthState] = await requireDb()
      .select()
      .from(providerOauthStates)
      .where(eq(providerOauthStates.providerAccountId, accountId));
    expect(oauthState?.leaseOwner).toBeNull();
    expect(account?.status).toBe("active");
  });

  test("refreshes disabled accounts without re-enabling or clearing cooldown health state", async () => {
    const cooldownUntil = new Date(Date.now() + 15 * 60 * 1000);
    const accountId = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-disabled",
      expiresAt: new Date(Date.now() + 60 * 1000),
      status: "disabled",
      cooldownUntil,
    });
    const service = new OAuthRefreshService(requireDb());
    const token = await service.ensureFreshAccessToken(
      accountId,
      fakeRefresher(async () => ({
        access: "refreshed-disabled",
        refresh: "refresh-disabled-2",
        expiresAt: new Date(Date.now() + 3600_000),
      })),
    );
    expect(token).toBe("refreshed-disabled");

    const [account] = await requireDb()
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    expect(account?.status).toBe("disabled");
    expect(account?.cooldownUntil?.getTime()).toBe(cooldownUntil.getTime());
    expect(account?.consecutiveFailures).toBe(0);
    expect(account?.lastSuccessAt).toBeNull();
  });

  test("in-process concurrent callers share a single upstream refresh call", async () => {
    const accountId = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    const service = new OAuthRefreshService(requireDb());
    let callCount = 0;
    const refresher = fakeRefresher(async () => {
      callCount += 1;
      await new Promise((r) => setTimeout(r, 50));
      return {
        access: "new-access",
        refresh: "new-refresh",
        expiresAt: new Date(Date.now() + 3600_000),
      };
    });
    const [a, b, c] = await Promise.all([
      service.ensureFreshAccessToken(accountId, refresher),
      service.ensureFreshAccessToken(accountId, refresher),
      service.ensureFreshAccessToken(accountId, refresher),
    ]);
    expect(callCount).toBe(1);
    expect(a).toBe("new-access");
    expect(b).toBe("new-access");
    expect(c).toBe("new-access");
  });

  test("a definitive failure disables the account and clears the lease", async () => {
    const accountId = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    const service = new OAuthRefreshService(requireDb());
    const refresher = fakeRefresher(async () => {
      throw new Error('{"error":"invalid_grant","error_description":"revoked"}');
    });
    const token = await service.ensureFreshAccessToken(accountId, refresher);
    expect(token).toBeNull();

    const [account] = await requireDb()
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    const [oauthState] = await requireDb()
      .select()
      .from(providerOauthStates)
      .where(eq(providerOauthStates.providerAccountId, accountId));
    expect(account?.status).toBe("disabled");
    expect(oauthState?.leaseOwner).toBeNull();
  });

  test("a transient failure releases the lease without disabling the account", async () => {
    const accountId = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    const service = new OAuthRefreshService(requireDb());
    const refresher = fakeRefresher(async () => {
      throw new Error("upstream timed out");
    });
    const token = await service.ensureFreshAccessToken(accountId, refresher);
    expect(token).toBeNull();

    const [account] = await requireDb()
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    const [oauthState] = await requireDb()
      .select()
      .from(providerOauthStates)
      .where(eq(providerOauthStates.providerAccountId, accountId));
    expect(account?.status).toBe("active");
    expect(oauthState?.leaseOwner).toBeNull();
  });

  test("loadDueOAuthAccounts returns only active OAuth accounts within the skew window", async () => {
    const due = await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    await insertAccount({
      providerId: "claude",
      refreshToken: "refresh-2",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await insertAccount({ providerId: "claude", refreshToken: undefined, expiresAt: undefined });

    const rows = await loadDueOAuthAccounts(requireDb());
    // Filtered to this suite's accounts: the shared isolated database also
    // holds other suites' OAuth accounts, and the query is deliberately
    // table-wide. What this test pins is that among the three rows inserted
    // above, only the due one is returned.
    expect(rows.map((r) => r.id).filter((id) => createdAccountIds.includes(id))).toEqual([due]);
  });
});
