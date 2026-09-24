import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../../src/persistence/postgres";
import { dbDescribe, testDatabaseUrl } from "../../helpers/db-gate";
import { tenants, providerAccounts, adminAuditLog } from "../../../src/persistence/schema";
import {
  createAccountQuotaRoutes,
  resetBackgroundQuotaRefreshesForTests,
} from "../../../src/console/quota/account-quota";
import {
  inFlightAccountQuotaRefreshes,
  listOAuthQuotaRefreshTargets,
  recordAccountCheck,
} from "../../../src/console/quota/quota-refresh";
import { clearQuotaCacheForTests } from "../../../src/console/quota/quota-cache";
import { createDefaultProviderRegistry } from "../../../src/providers/default-registry";
import { AuditRecorder } from "../../../src/console/auth/service";
import { encryptCredential, decryptCredentialToString } from "../../../src/security/crypto";
import type { AccessDecision } from "../../../src/security/access-control";
let db: CartethyiaDatabase;
let app: { handle(request: Request): Promise<Response> };

const testTenantId = randomUUID();

const mockAccess: AccessDecision = {
  id: "test-key",
  tenantId: testTenantId,
  scopes: ["dashboard:read", "dashboard:write"],
    admissionIdentity: "test-identity",
};
let activeAccess: AccessDecision | undefined = mockAccess;

const createdAccountIds: string[] = [];
const createdTenantIds: string[] = [];
let tenantCreated = false;

/**
 * Stand-in for the composition root's refresh-aware resolver: decrypts the
 * stored ciphertext, or returns "" when the account carries no credential.
 */
async function testResolveCredential(
  db: CartethyiaDatabase,
  _providerId: string,
  accountId: string,
): Promise<string> {
  const rows = await db
    .select({ credentialCiphertext: providerAccounts.credentialCiphertext })
    .from(providerAccounts)
    .where(eq(providerAccounts.id, accountId))
    .limit(1);
  const ciphertext = rows[0]?.credentialCiphertext;
  return ciphertext ? decryptCredentialToString(ciphertext) : "";
}

dbDescribe("Account quota routes", () => {
  beforeAll(() => {
    db = getDb();
    app = createAccountQuotaRoutes({
      db,
      accessResolver: (req: Request) =>
        req.headers.has("x-no-auth") ? undefined : activeAccess,
      resolveCredential: (providerId, accountId) => testResolveCredential(db, providerId, accountId),
      // Required deps (fail-closed): real registry; Redis fake is never hit by these tests (DB-gated paths stub the store).
      providerRegistry: createDefaultProviderRegistry(),
      redis: {} as never,
    });
  });

async function createTestAccount(providerId = "openai"): Promise<string> {
  if (!tenantCreated) {
    await db
      .insert(tenants)
      .values({ id: testTenantId, name: "quota-test-tenant", status: "active" });
    createdTenantIds.push(testTenantId);
    tenantCreated = true;
  }

  const accountId = randomUUID();
  createdAccountIds.push(accountId);
  await db.insert(providerAccounts).values({
    id: accountId,
    tenantId: testTenantId,
    providerId,
    label: "test-quota-account",
    credentialCiphertext: encryptCredential("sk-test-secret"),
    credentialKind: "api_key",
    status: "active",
  });
  return accountId;
}

  test("401s without auth", async () => {
    const res = await app.handle(
      new Request("http://localhost/accounts/some-id/quota", {
        headers: { "x-no-auth": "1" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("404s on non-existent account", async () => {
    const res = await app.handle(new Request(`http://localhost/accounts/${randomUUID()}/quota`));
    expect(res.status).toBe(404);
  });

  test("200s on valid account quota fetch", async () => {
    const accountId = await createTestAccount();
    const res = await app.handle(new Request(`http://localhost/accounts/${accountId}/quota`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accountId: string; quota: { source: string } };
    expect(body.accountId).toBe(accountId);
    expect(body.quota).toBeDefined();
  });

  test("the overview answers from the cache without waiting on upstream", async () => {
    const accountId = await createTestAccount();
    // openai has no quota collector, so any upstream attempt fails; a cached
    // entry must still come back on the first read with no fetch involved.
    const { setCachedQuota } = await import("../../../src/console/quota/quota-cache");
    await setCachedQuota(
      testTenantId,
      accountId,
      { source: "openai", plan: "cached-plan", windows: [], error: null },
      {} as never,
    );

    const res = await app.handle(new Request("http://localhost/quota/overview"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{ id: string; quota: { plan: string | null; fetchedAt: string | null } | null; pending: boolean }>;
    };
    const row = body.accounts.find((account) => account.id === accountId);
    expect(row?.quota?.plan).toBe("cached-plan");
    // The cached entry carries its own fetch time, so the page's "Last
    // refreshed" no longer reports an unrelated account timestamp.
    expect(row?.quota?.fetchedAt).toBeTruthy();
    expect(row?.pending).toBe(false);
  });

  test("the overview dropdown lists only providers with a quota endpoint", async () => {
    await createTestAccount("claude");
    const res = await app.handle(new Request("http://localhost/quota/overview"));
    const body = (await res.json()) as {
      accounts: Array<{ id: string; provider: string }>;
      providers: Array<{ id: string; name: string }>;
    };
    const ids = body.providers.map((provider) => provider.id);
    const accountProviders = [...new Set(body.accounts.map((account) => account.provider))];
    // openai registers no quota collector: its accounts may render rows, but
    // it must never appear as a dropdown option. claude does declare one.
    expect(ids).not.toContain("openai");
    expect(accountProviders).toContain("openai");
    expect(ids).toContain("claude");
    expect(ids.length).toBeLessThan(accountProviders.length);
  });

  test("200s on batch active toggle", async () => {
    const accountId = await createTestAccount();
    const res = await app.handle(
      new Request("http://localhost/accounts/batch", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [accountId], active: false }),
      }),
    );
    expect(res.status).toBe(200);

    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.status).toBe("disabled");
  });

  test("returns real succeeded/failed counts on bulk quota refresh", async () => {
    const accountId = await createTestAccount("cerebras");
    const res = await app.handle(
      new Request("http://localhost/quota/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountIds: [accountId] }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      queued: number;
      succeeded: number;
      failed: number;
      failures: Array<{ accountId: string; code: string }>;
    };
    // Fake credential, no upstream network: the fetch fails and is reported
    // as a typed failure rather than counted as refreshed.
    expect(body.queued).toBe(1);
    expect(body.succeeded).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.failures[0]?.accountId).toBe(accountId);
    expect(body.ok).toBe(false);
  });

  test("collectorless providers skip refresh instead of failing", async () => {
    // openai registers no quota collector: single, bulk, and overview paths
    // must not manufacture the "not available" error.
    const accountId = await createTestAccount("openai");
    const single = await app.handle(
      new Request(`http://localhost/accounts/${accountId}/quota/refresh`, { method: "POST" }),
    );
    expect(single.status).toBe(200);
    const singleBody = (await single.json()) as { ok: boolean; data: { quota: null } };
    expect(singleBody.ok).toBe(true);
    expect(singleBody.data.quota).toBeNull();

    const bulk = await app.handle(
      new Request("http://localhost/quota/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountIds: [accountId] }),
      }),
    );
    const bulkBody = (await bulk.json()) as { ok: boolean; succeeded: number; failed: number };
    expect(bulkBody.ok).toBe(true);
    expect(bulkBody.succeeded).toBe(1);
    expect(bulkBody.failed).toBe(0);

    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.lastError).toBeNull();
    expect(rows[0]?.lastErrorCategory).toBeNull();
  });

  test("single refresh stamps the failure on the account row", async () => {
    const accountId = await createTestAccount("cerebras");
    const res = await app.handle(
      new Request(`http://localhost/accounts/${accountId}/quota/refresh`, { method: "POST" }),
    );
    // cerebras has a quota collector: deterministic failure, no network.
    expect(res.status).toBe(502);
    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.lastError).toBeTruthy();
    expect(rows[0]?.lastErrorCategory).toBe("quota_fetch_failed");
    expect(rows[0]?.lastErrorAt).toBeInstanceOf(Date);
    expect(rows[0]?.lastSuccessAt).toBeNull();
    // A manual check reports only: status untouched.
    expect(rows[0]?.status).toBe("active");
  });

  test("bulk refresh stamps the failure on the account row", async () => {
    const accountId = await createTestAccount("cerebras");
    const res = await app.handle(
      new Request("http://localhost/quota/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountIds: [accountId] }),
      }),
    );
    expect(res.status).toBe(200);
    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.lastErrorCategory).toBe("quota_fetch_failed");
    expect(rows[0]?.lastErrorAt).toBeInstanceOf(Date);
  });

  test("recordAccountCheck success stamps success and clears errors", async () => {
    const accountId = await createTestAccount();
    await recordAccountCheck(db, accountId, {
      ok: false,
      error: "boom",
      category: "quota_fetch_failed",
    });
    await recordAccountCheck(db, accountId, { ok: true });
    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.lastSuccessAt).toBeInstanceOf(Date);
    expect(rows[0]?.lastError).toBeNull();
    expect(rows[0]?.lastErrorCategory).toBeNull();
    expect(rows[0]?.lastErrorAt).toBeNull();
  });

  test("the periodic sweep skips revoked credentials but keeps probing other accounts", async () => {
    // Two rules, and the difference matters:
    //  - `auth_invalidated` means the credential was rejected outright and does
    //    not repair itself, so every sweep is a guaranteed 401 that only
    //    re-confirms the row and floods the log. The operator needs a re-login.
    //  - Any other account is swept even when `disabled`: a disabled row is not
    //    necessarily a revoked one, and skipping it would let a credential die
    //    silently while the row still reads healthy.
    const activeId = randomUUID();
    const disabledOtherId = randomUUID();
    const revokedId = randomUUID();
    createdAccountIds.push(activeId, disabledOtherId, revokedId);
    await db.insert(providerAccounts).values([
      {
        id: activeId,
        tenantId: testTenantId,
        providerId: "grok",
        label: "sweep-active",
        credentialCiphertext: encryptCredential("oauth-token"),
        credentialKind: "oauth",
        status: "active",
      },
      {
        id: disabledOtherId,
        tenantId: testTenantId,
        providerId: "grok",
        label: "sweep-disabled-other-reason",
        credentialCiphertext: encryptCredential("oauth-token"),
        credentialKind: "oauth",
        status: "disabled",
        lastErrorCategory: "quota_exhausted",
      },
      {
        id: revokedId,
        tenantId: testTenantId,
        providerId: "grok",
        label: "sweep-revoked",
        credentialCiphertext: encryptCredential("oauth-token"),
        credentialKind: "oauth",
        status: "disabled",
        lastErrorCategory: "auth_invalidated",
      },
    ]);

    const ids = (await listOAuthQuotaRefreshTargets(db)).map((target) => target.accountId);
    expect(ids).toContain(activeId);
    expect(ids).toContain(disabledOtherId);
    expect(ids).not.toContain(revokedId);
  });

  test("a check never overwrites a parked account's reason", async () => {
    const accountId = await createTestAccount();
    // The dispatch health machine parked the account and recorded why.
    await db
      .update(providerAccounts)
      .set({
        status: "disabled",
        lastError: "Provider credential rejected: Invalid or expired credentials",
        lastErrorCategory: "auth_invalidated",
        lastErrorAt: new Date(),
      })
      .where(eq(providerAccounts.id, accountId));

    // A periodic quota sweep then fails with its own, unrelated reason.
    await recordAccountCheck(db, accountId, {
      ok: false,
      error: "Grok Build billing request failed (401)",
      category: "quota_fetch_failed",
    });

    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.status).toBe("disabled");
    expect(rows[0]?.lastErrorCategory).toBe("auth_invalidated");
    expect(rows[0]?.lastError).toContain("credential rejected");
  });

  test("400s on empty bulk quota refresh", async () => {
    const res = await app.handle(
      new Request("http://localhost/quota/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountIds: [] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("deduplicates concurrent refresh requests for the same account", async () => {
    const accountId = await createTestAccount();
    expect(inFlightAccountQuotaRefreshes.has(accountId)).toBe(false);

    const req1 = app.handle(
      new Request(`http://localhost/accounts/${accountId}/quota/refresh`, {
        method: "POST",
      }),
    );
    const req2 = app.handle(
      new Request(`http://localhost/accounts/${accountId}/quota/refresh`, {
        method: "POST",
      }),
    );

    // Both requests are initiated concurrently; during in-flight execution, deduplication map should have entry or have settled
    const [res1, res2] = await Promise.all([req1, req2]);

    expect(res1.status).toBe(res2.status);
    const body1 = (await res1.json()) as { ok: boolean; data: { id: string } };
    const body2 = (await res2.json()) as { ok: boolean; data: { id: string } };
    expect(body1.data.id).toBe(accountId);
    expect(body2.data.id).toBe(accountId);

    // Map is cleaned up on settle
    expect(inFlightAccountQuotaRefreshes.has(accountId)).toBe(false);
  });

  test("400s on unknown single-account status", async () => {
    const accountId = await createTestAccount();
    const res = await app.handle(
      new Request(`http://localhost/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "super-active" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("404s on single-account patch for a missing account", async () => {
    const res = await app.handle(
      new Request(`http://localhost/accounts/${randomUUID()}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("400s on batch toggle over the id cap", async () => {
    const res = await app.handle(
      new Request("http://localhost/accounts/batch", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from({ length: 101 }, () => randomUUID()), active: true }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("403s when the caller lacks the required write scope", async () => {
    activeAccess = {
      ...mockAccess,
      scopes: ["dashboard:read"],
    };
    const res = await app.handle(
      new Request(`http://localhost/accounts/${randomUUID()}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      }),
    );
    expect(res.status).toBe(403);
    activeAccess = mockAccess;
  });


  test("hides an account owned by another tenant", async () => {
    const accountId = await createTestAccount();
    activeAccess = {
      ...mockAccess,
      tenantId: randomUUID(),
    };
    const res = await app.handle(
      new Request(`http://localhost/accounts/${accountId}/quota`),
    );
    expect(res.status).toBe(404);
    activeAccess = mockAccess;
  });

  test("records an audit entry when an account is deleted", async () => {
    const accountId = await createTestAccount();
    const auditApp = createAccountQuotaRoutes({
      db,
      accessResolver: () => mockAccess,
      auditRecorder: new AuditRecorder(db),
      resolveCredential: (providerId, accountId) => testResolveCredential(db, providerId, accountId),
      providerRegistry: createDefaultProviderRegistry(),
      redis: {} as never,
    });
    const res = await auditApp.handle(
      new Request(`http://localhost/accounts/${accountId}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    const rows = await db.select().from(adminAuditLog).where(eq(adminAuditLog.target, accountId));
    expect(rows.some((row) => row.action === "provider_account.deleted")).toBe(true);
  });

  test("checkin 404s on an unknown account", async () => {
    const res = await app.handle(
      new Request(`http://localhost/accounts/${randomUUID()}/checkin`, { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });

  test("checkin 400s on a provider without a billing facade", async () => {
    const accountId = await createTestAccount("openai");
    const res = await app.handle(
      new Request(`http://localhost/accounts/${accountId}/checkin`, { method: "POST" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("checkin_unsupported");
  });

  test("checkin 401s without auth", async () => {
    const res = await app.handle(
      new Request(`http://localhost/accounts/${randomUUID()}/checkin`, {
        method: "POST",
        headers: { "x-no-auth": "1" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("checkin hides an account owned by another tenant", async () => {
    const accountId = await createTestAccount("workbuddy");
    activeAccess = { ...mockAccess, tenantId: randomUUID() };
    const res = await app.handle(
      new Request(`http://localhost/accounts/${accountId}/checkin`, { method: "POST" }),
    );
    expect(res.status).toBe(404);
    activeAccess = mockAccess;
  });
});
dbDescribe("Global account administration", () => {
  const globalAccess: AccessDecision = {
    ...mockAccess,
    tenantId: "platform-admin-tenant",
    scopes: ["dashboard:read", "dashboard:write", "platform:admin"],
  };

  async function createGlobalAccount(): Promise<string> {
    const accountId = randomUUID();
    createdAccountIds.push(accountId);
    await db.insert(providerAccounts).values({
      id: accountId,
      tenantId: null,
      providerId: "openai",
      label: "global-quota-account",
      credentialCiphertext: encryptCredential("sk-global-secret"),
      credentialKind: "api_key",
      status: "active",
    });
    return accountId;
  }

  function globalApp() {
    return createAccountQuotaRoutes({
      db,
      accessResolver: () => globalAccess,
      resolveCredential: (providerId, accountId) => testResolveCredential(db, providerId, accountId),
      providerRegistry: createDefaultProviderRegistry(),
      redis: {} as never,
    });
  }

  test("ordinary tenants cannot see global accounts", async () => {
    const accountId = await createGlobalAccount();
    const res = await app.handle(new Request(`http://localhost/accounts/${accountId}/quota`));
    expect(res.status).toBe(404);
  });

  test("non-admins are denied global administration", async () => {
    const res = await app.handle(new Request("http://localhost/global/accounts"));
    expect(res.status).toBe(403);
  });

  test("platform admin lists and disables a global account with audit", async () => {
    const accountId = await createGlobalAccount();
    const list = await globalApp().handle(new Request("http://localhost/global/accounts"));
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { accounts: Array<{ id: string }> };
    expect(listed.accounts.some((row) => row.id === accountId)).toBe(true);

    const patched = await globalApp().handle(
      new Request(`http://localhost/global/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      }),
    );
    expect(patched.status).toBe(200);
    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.status).toBe("disabled");
    const audit = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.target, accountId));
    expect(audit.some((row) => row.action === "provider_account.global.updated")).toBe(true);
  });

  test("a global account status PATCH invalidates the route snapshot once", async () => {
    const accountId = await createGlobalAccount();
    let invalidations = 0;
    const invalidatingApp = createAccountQuotaRoutes({
      db,
      accessResolver: () => globalAccess,
      resolveCredential: (providerId, accountId) =>
        testResolveCredential(db, providerId, accountId),
      providerRegistry: createDefaultProviderRegistry(),
      redis: {} as never,
      snapshotInvalidator: {
        invalidate: async () => {
          invalidations += 1;
          return invalidations;
        },
      },
    });
    const res = await invalidatingApp.handle(
      new Request(`http://localhost/global/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      }),
    );
    expect(res.status).toBe(200);
    expect(invalidations).toBe(1);
  });

  test("a platform admin deletes a global account with audit", async () => {
    const accountId = await createGlobalAccount();
    const res = await globalApp().handle(
      new Request(`http://localhost/global/accounts/${accountId}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(rows).toHaveLength(0);
    const audit = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.target, accountId));
    expect(audit.some((row) => row.action === "provider_account.global.deleted")).toBe(true);
  });

  test("the tenant-scoped delete cannot remove a global account", async () => {
    // Regression pin for the reported bug: shared accounts carry
    // `tenant_id IS NULL`, so `DELETE /accounts/:id` (which filters on
    // `tenant_id = <uuid>`) always 404s for them. The global route is the
    // only path that can match, and the tenant path must keep refusing.
    const accountId = await createGlobalAccount();
    const viaTenant = await app.handle(
      new Request(`http://localhost/accounts/${accountId}`, { method: "DELETE" }),
    );
    expect(viaTenant.status).toBe(404);
    const stillThere = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    expect(stillThere).toHaveLength(1);
  });

  test("non-admins cannot delete a global account", async () => {
    const accountId = await createGlobalAccount();
    const res = await app.handle(
      new Request(`http://localhost/global/accounts/${accountId}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(403);
    const stillThere = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    expect(stillThere).toHaveLength(1);
  });

  test("deleting an unknown global account is a 404", async () => {
    const res = await globalApp().handle(
      new Request(`http://localhost/global/accounts/${randomUUID()}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });
});

// Registered at file scope, not inside either `dbDescribe`: both suites share
// `createdAccountIds` / `createdTenantIds`, and a hook scoped to the first
// describe ran before the second one created its global accounts, so every run
// left those rows behind. Guarded on the same URL `dbDescribe` gates on, since
// `db` is only assigned when the DB suites actually run.
if (testDatabaseUrl) {
  afterEach(() => {
    // The quota cache and the background queue are process-wide; leaving entries
    // behind makes a later test see another test's quota.
    clearQuotaCacheForTests();
    resetBackgroundQuotaRefreshesForTests();
  });

  afterAll(async () => {
    const accountIds = createdAccountIds.splice(0);
    for (const id of accountIds) {
      await db.delete(providerAccounts).where(eq(providerAccounts.id, id));
    }
    if (accountIds.length > 0) {
      await db.delete(adminAuditLog).where(inArray(adminAuditLog.target, accountIds));
    }
    for (const id of createdTenantIds.splice(0)) {
      await db.delete(tenants).where(eq(tenants.id, id));
    }
  });
}

dbDescribe("Account activity report", () => {
  async function createReportTestAccount(providerId = "openai"): Promise<string> {
    if (!tenantCreated) {
      await db
        .insert(tenants)
        .values({ id: testTenantId, name: "quota-test-tenant", status: "active" });
      createdTenantIds.push(testTenantId);
      tenantCreated = true;
    }
    const accountId = randomUUID();
    createdAccountIds.push(accountId);
    await db.insert(providerAccounts).values({
      id: accountId,
      tenantId: testTenantId,
      providerId,
      label: "test-report-account",
      credentialCiphertext: encryptCredential("sk-test-secret"),
      credentialKind: "api_key",
      status: "active",
    });
    return accountId;
  }

  test("report 404s on an unknown account", async () => {
    const res = await app.handle(
      new Request(`http://localhost/accounts/${randomUUID()}/activity-report`, { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });

  test("report 400s on a provider without a billing facade", async () => {
    const accountId = await createReportTestAccount("openai");
    const res = await app.handle(
      new Request(`http://localhost/accounts/${accountId}/activity-report`, { method: "POST" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("report_unsupported");
  });

  test("report 401s without auth", async () => {
    const res = await app.handle(
      new Request(`http://localhost/accounts/${randomUUID()}/activity-report`, {
        method: "POST",
        headers: { "x-no-auth": "1" },
      }),
    );
    expect(res.status).toBe(401);
  });
});

dbDescribe("Account rate-limit reset", () => {
  async function createResetTestAccount(providerId = "openai"): Promise<string> {
    if (!tenantCreated) {
      await db
        .insert(tenants)
        .values({ id: testTenantId, name: "quota-test-tenant", status: "active" });
      createdTenantIds.push(testTenantId);
      tenantCreated = true;
    }
    const accountId = randomUUID();
    createdAccountIds.push(accountId);
    await db.insert(providerAccounts).values({
      id: accountId,
      tenantId: testTenantId,
      providerId,
      label: "test-reset-account",
      credentialCiphertext: encryptCredential("sk-test-secret"),
      credentialKind: "api_key",
      status: "active",
    });
    return accountId;
  }

  test("reset 404s on an unknown account", async () => {
    const res = await app.handle(
      new Request(`http://localhost/accounts/${randomUUID()}/reset`, { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });

  test("reset 400s on a provider without reset support", async () => {
    const accountId = await createResetTestAccount("openai");
    const res = await app.handle(
      new Request(`http://localhost/accounts/${accountId}/reset`, { method: "POST" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("reset_unsupported");
  });

  test("reset 401s without auth", async () => {
    const res = await app.handle(
      new Request(`http://localhost/accounts/${randomUUID()}/reset`, {
        method: "POST",
        headers: { "x-no-auth": "1" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("reset hides an account owned by another tenant", async () => {
    const accountId = await createResetTestAccount("codex");
    activeAccess = { ...mockAccess, tenantId: randomUUID() };
    const res = await app.handle(
      new Request(`http://localhost/accounts/${accountId}/reset`, { method: "POST" }),
    );
    expect(res.status).toBe(404);
    activeAccess = mockAccess;
  });

  test("listing resets 404s on an unknown account", async () => {
    const res = await app.handle(
      new Request(`http://localhost/accounts/${randomUUID()}/resets`),
    );
    expect(res.status).toBe(404);
  });

  test("listing resets returns an empty set for an unsupported provider", async () => {
    const accountId = await createResetTestAccount("openai");
    const res = await app.handle(new Request(`http://localhost/accounts/${accountId}/resets`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { availableCount: number; credits: unknown[] };
    expect(body.availableCount).toBe(0);
    expect(body.credits).toEqual([]);
  });
});
