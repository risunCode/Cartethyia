import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import { tenants, providerAccounts } from "../../../src/persistence/schema";
import {
  classifyAccountError,
  listAccountHealthEvents,
  recordAccountFailure,
  recordAccountSuccess,
  recoverAccount,
  reportAttemptOutcome,
  sweepExpiredCooldowns,
} from "../../../src/providers/operations/account-health-service";
import { parseRetryAfter } from "../../../src/transport/failure-policy";
import { encryptCredential } from "../../../src/security/crypto";
describe("account-recorder.test.ts", () => {
dbDescribe("Account Health Recorder & Auto-Recovery", () => {
  const createdAccountIds: string[] = [];
  const createdTenantIds: string[] = [];

  async function createTestAccount(status: "active" | "cooldown" | "disabled" = "active") {
    const db = getDb();
    const tenantId = randomUUID();
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "account-recorder-test", status: "active" });
    createdTenantIds.push(tenantId);

    const accountId = randomUUID();
    createdAccountIds.push(accountId);
    await db.insert(providerAccounts).values({
      id: accountId,
      tenantId,
      providerId: "openai",
      label: "test-recorder-account",
      credentialCiphertext: encryptCredential("sk-test-secret"),
      credentialKind: "api_key",
      status,
    });
    return { tenantId, accountId };
  }

  afterAll(async () => {
    const db = getDb();
    for (const id of createdAccountIds.splice(0)) {
      await db.delete(providerAccounts).where(eq(providerAccounts.id, id));
    }
    for (const id of createdTenantIds.splice(0)) {
      await db.delete(tenants).where(eq(tenants.id, id));
    }
  });

  test("records rate limit failure, sets cooldown, and creates transition event", async () => {

    const { accountId } = await createTestAccount("active");

    const classification = await recordAccountFailure(
      getDb(),
      accountId,
      new Error("Rate limit reached: requests per minute exceeded"),
      { origin: "upstream", scope: "account", statusCode: 429 },
    );

    expect(classification).not.toBeNull();
    expect(classification?.status).toBe("cooldown");

    const rows = await getDb().select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.status).toBe("cooldown");
    expect(rows[0]?.consecutiveFailures).toBe(1);
    expect(rows[0]?.lastErrorCategory).toBe("rate_limit_transient");
    expect(rows[0]?.cooldownUntil).toBeDefined();

    const events = await listAccountHealthEvents(getDb(), accountId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.fromStatus).toBe("active");
    expect(events[0]?.toStatus).toBe("cooldown");
    expect(events[0]?.errorCategory).toBe("rate_limit_transient");
  });


  test("records success and resets failures when recovered", async () => {
    const db = getDb();
    const { accountId } = await createTestAccount("cooldown");
    await recordAccountSuccess(db, accountId);

    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.consecutiveFailures).toBe(0);
    expect(rows[0]?.lastSuccessAt).toBeDefined();
  });

  test("manual recoverAccount transitions account to active and logs event", async () => {
    const db = getDb();
    const { accountId } = await createTestAccount("cooldown");

    const ok = await recoverAccount(db, accountId, "manual_operator_recovery");
    expect(ok).toBe(true);

    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.consecutiveFailures).toBe(0);
    expect(rows[0]?.cooldownUntil).toBeNull();

    const events = await listAccountHealthEvents(db, accountId);
    expect(events[0]?.toStatus).toBe("active");
    expect(events[0]?.reason).toBe("manual_operator_recovery");
  });

  test("recoverAccount clears per-model cooldowns and the error fields", async () => {
    const db = getDb();
    const { accountId } = await createTestAccount("cooldown");

    // A per-model cooldown excludes the (account, model) pair in the routing
    // catalog, so a recovery that left it behind kept the account blocked for
    // that model over `/v1` while a direct probe — which addresses the account
    // by id and bypasses routing eligibility — succeeded.
    await db
      .update(providerAccounts)
      .set({
        modelCooldowns: { "gpt-5": new Date(Date.now() + 60_000).toISOString() },
        lastError: "Provider rate limit: slow down",
        lastErrorCategory: "rate_limit_transient",
        lastErrorAt: new Date(),
      })
      .where(eq(providerAccounts.id, accountId));

    expect(await recoverAccount(db, accountId, "manual_operator_recovery")).toBe(true);

    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.cooldownUntil).toBeNull();
    expect(rows[0]?.modelCooldowns).toEqual({});
    expect(rows[0]?.lastError).toBeNull();
    expect(rows[0]?.lastErrorCategory).toBeNull();
    expect(rows[0]?.lastErrorAt).toBeNull();
  });

  test("model-level cooldown writes to modelCooldowns for 429 failures", async () => {
    const db = getDb();
    const { accountId } = await createTestAccount("active");

    const classification = await recordAccountFailure(
      db,
      accountId,
      new Error("Rate limit reached: requests per minute exceeded"),
      { origin: "upstream", scope: "account", statusCode: 429, modelId: "gpt-5" },
    );

    expect(classification?.category).toBe("rate_limit_transient");
    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    const cooldowns = rows[0]?.modelCooldowns as Record<string, string>;
    expect(cooldowns["gpt-5"]).toBeDefined();
    expect(new Date(cooldowns["gpt-5"]!).getTime()).toBeGreaterThan(Date.now());
    // Account-wide cooldown should not be set for model-level throttling.
    expect(rows[0]?.cooldownUntil).toBeNull();
    // The error fields ARE stamped: provider detail explains why the model is
    // cooling instead of showing a reasonless "1 model cooling".
    expect(rows[0]?.lastErrorCategory).toBe("rate_limit_transient");
    expect(rows[0]?.lastErrorAt).toBeInstanceOf(Date);
  });

  test("sweepExpiredCooldowns prunes expired model cooldown keys", async () => {
    const db = getDb();
    const { accountId } = await createTestAccount("active");

    await db
      .update(providerAccounts)
      .set({
        modelCooldowns: {
          "old-model": new Date(Date.now() - 60_000).toISOString(),
          "fresh-model": new Date(Date.now() + 60_000).toISOString(),
        },
      })
      .where(eq(providerAccounts.id, accountId));

    const swept = await sweepExpiredCooldowns(db);
    expect(swept).toBeGreaterThanOrEqual(1);

    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    const cooldowns = rows[0]?.modelCooldowns as Record<string, string>;
    expect(cooldowns["old-model"]).toBeUndefined();
    expect(cooldowns["fresh-model"]).toBeDefined();
  });

  test("sweepExpiredCooldowns transitions expired accounts to active", async () => {
    const db = getDb();
    const { accountId } = await createTestAccount("cooldown");

    // Set cooldownUntil in the past
    const past = new Date(Date.now() - 60_000);
    await db
      .update(providerAccounts)
      .set({ cooldownUntil: past })
      .where(eq(providerAccounts.id, accountId));

    const sweptCount = await sweepExpiredCooldowns(db);
    expect(sweptCount).toBeGreaterThanOrEqual(1);

    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.cooldownUntil).toBeNull();

    const events = await listAccountHealthEvents(db, accountId);
    expect(events[0]?.reason).toContain("auto-recovered");
  });

  test("quarantines one model without opening the account", async () => {
    const db = getDb();
    const { accountId } = await createTestAccount("active");
    const fail = (modelId: string, origin: "upstream" | "cartethyia" = "upstream") =>
      reportAttemptOutcome(db, {
        accountId,
        modelId,
        error: new Error("model overloaded"),
        evidence: { origin, scope: "account", statusCode: 503 },
      });
    const cooldownsOf = async (): Promise<Record<string, string>> => {
      const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
      return (rows[0]?.modelCooldowns as Record<string, string> | null) ?? {};
    };

    await fail("poison-model");
    const quarantined = await cooldownsOf();
    expect(quarantined["poison-model"]).toBeDefined();
    expect(new Date(quarantined["poison-model"]!).getTime()).toBeGreaterThan(Date.now());
    // Sibling model untouched; model capacity is isolated from account state.
    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.status).not.toBe("disabled");

    // Local rejections never count toward quarantine.
    await fail("local-model", "cartethyia");
    await fail("local-model", "cartethyia");
    await fail("local-model", "cartethyia");
    expect(await cooldownsOf()).not.toHaveProperty("local-model");

  });
});

describe("Account Error Classifier", () => {
  test("classifies auth invalidation as permanent disabled", () => {
    const res = classifyAccountError(new Error("Invalid API key provided"), {
      origin: "upstream",
      scope: "account",
      credentialEvidence: true,
      statusCode: 401,
    });
    expect(res.status).toBe("disabled");
    expect(res.cooldownMs).toBe(0);
    expect(res.retryAt).toBeNull();
  });

  test("classifies 24h quota exhaustion with exact extracted cooldown", () => {
    const res = classifyAccountError(
      new Error("You exceeded your current quota, quota will reset in 24 hours"),
      { statusCode: 429 },
    );
    expect(res.category).toBe("quota_exhausted");
    expect(res.status).toBe("cooldown");
    expect(res.cooldownMs).toBe(24 * 3600 * 1000);
    expect(res.retryAt).not.toBeNull();
  });

  test("honors the absolute reset instant in a live WorkBuddy 429 message", () => {
    // Real shape: 429, providerCode 6004, message states an absolute instant in
    // UTC+8 ("...your usage will reset at 2026-09-24 02:12:51 UTC+8..."). A
    // relative-only parser returned null, so the account got the 15-minute
    // default and kept re-entering rotation inside the provider's window.
    // The stamp is generated dynamically so the assertion never expires.
    const resetInstant = new Date(Date.now() + 10 * 3600_000);
    const wallClock = new Date(resetInstant.getTime() + 8 * 3600_000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const res = classifyAccountError(
      new Error(
        `usage exceeds frequency limit, but don't worry, your usage will reset at ${wallClock} UTC+8, alternatively, you can switch to the other models to continue using it.`,
      ),
      {
        origin: "upstream",
        scope: "provider",
        providerId: "workbuddy",
        providerCode: "6004",
        statusCode: 429,
      },
    );
    expect(res.category).toBe("rate_limit_transient");
    expect(res.status).toBe("cooldown");
    // Not the 15-minute fallback: the provider named a specific instant.
    expect(res.cooldownMs).toBeGreaterThan(15 * 60 * 1000);
    expect(Math.abs((res.retryAt?.getTime() ?? 0) - resetInstant.getTime())).toBeLessThan(2_000);
  });

  test("classifies transient rate limit 429 with default 15 minutes cooldown", () => {
    const res = classifyAccountError(new Error("Rate limit reached for requests per minute"), {
      statusCode: 429,
    });
    expect(res.category).toBe("rate_limit_transient");
    expect(res.status).toBe("cooldown");
    expect(res.cooldownMs).toBe(15 * 60 * 1000);
  });

  test("mutates the failing account on provider-scoped upstream 429", () => {
    const res = classifyAccountError(new Error("Rate limit reached for requests per minute"), {
      origin: "upstream",
      scope: "provider",
      statusCode: 429,
    });
    expect(res.category).toBe("rate_limit_transient");
    expect(res.status).toBe("cooldown");
    expect(res.mutatesAccount).toBe(true);
  });

  test("mutates the failing account on upstream 500 with quota_exceeded provider code", () => {
    const res = classifyAccountError(new Error("quota_exceeded: daily budget exhausted"), {
      origin: "upstream",
      scope: "provider",
      providerCode: "quota_exceeded",
      statusCode: 500,
    });
    expect(res.category).toBe("quota_exhausted");
    expect(res.status).toBe("cooldown");
    expect(res.mutatesAccount).toBe(true);
  });

  test("classifies xAI free-usage exhaustion as a 24h quota cooldown", () => {
    // Live shape: xAI returns 429 with `{"error": {"code":
    // "subscription:free-usage-exhausted"}}` (no message), so the gateway
    // message itself is the provider code. Grok Build's free tier resets on a
    // rolling 24-hour window, so the code alone must yield a full-day cooldown
    // rather than the generic 1h fallback.
    const res = classifyAccountError(new Error("subscription:free-usage-exhausted"), {
      origin: "upstream",
      scope: "provider",
      providerCode: "subscription:free-usage-exhausted",
      statusCode: 429,
    });
    expect(res.category).toBe("quota_exhausted");
    expect(res.status).toBe("cooldown");
    expect(res.cooldownMs).toBe(24 * 3600 * 1000);
    expect(res.retryAt).not.toBeNull();
    expect(res.mutatesAccount).toBe(true);
  });

  test("computes quota cooldown from a stated rolling-window duration", () => {
    // Full live xAI human text states the cadence; the parser must use it.
    const res = classifyAccountError(
      new Error(
        "You've used all the included free usage for model grok-4.6 for now. " +
          "Usage resets over a rolling 24-hour window",
      ),
      {
        origin: "upstream",
        scope: "provider",
        providerCode: "subscription:free-usage-exhausted",
        statusCode: 429,
      },
    );
    expect(res.category).toBe("quota_exhausted");
    expect(res.cooldownMs).toBe(24 * 3600 * 1000);
    expect(res.mutatesAccount).toBe(true);
  });

  test("free-usage exhaustion on 403 cools down instead of disabling the credential", () => {
    const res = classifyAccountError(new Error("subscription:free-usage-exhausted"), {
      origin: "upstream",
      scope: "provider",
      credentialEvidence: true,
      providerCode: "subscription:free-usage-exhausted",
      statusCode: 403,
    });
    expect(res.category).toBe("quota_exhausted");
    expect(res.status).toBe("cooldown");
    expect(res.mutatesAccount).toBe(true);
  });

  test("CodeBuddy safety-policy 403 (11140) never disables the account", () => {
    const res = classifyAccountError(
      new Error('{"code":11140,"msg":"request illegal","displayMsg":{"en":"The content did not pass the safety review."}}'),
      {
        origin: "upstream",
        scope: "account",
        credentialEvidence: true,
        providerCode: "11140",
        statusCode: 403,
      },
    );
    // Deterministic content-policy rejection: the credential is healthy, so
    // this must NOT be auth_invalidated/disabled — refreshing the token cannot
    // change the outcome and the account must not be parked.
    expect(res.category).not.toBe("auth_invalidated");
    expect(res.status).not.toBe("disabled");
    expect(res.mutatesAccount).toBe(false);
  });

  test("buddy-family 11140 parks the account in a 24h cooldown, never disabled", () => {
    // On the buddy family the block persists across every invocation, so the
    // account must leave rotation — but as a cooldown, because the credential
    // is valid and the block clears upstream on its own.
    for (const providerId of ["cb", "cbcn", "workbuddy"]) {
      const res = classifyAccountError(
        new Error('{"code":11140,"msg":"request illegal"}'),
        {
          origin: "upstream",
          scope: "account",
          credentialEvidence: true,
          providerCode: "11140",
          providerId,
          statusCode: 403,
        },
      );
      expect({ providerId, category: res.category }).toEqual({
        providerId,
        category: "policy_blocked",
      });
      expect(res.status).toBe("cooldown");
      expect(res.status).not.toBe("disabled");
      expect(res.cooldownMs).toBe(24 * 3600 * 1000);
      expect(res.retryAt).not.toBeNull();
      expect(res.mutatesAccount).toBe(true);
    }
  });

  test("a non-buddy provider keeps a policy rejection out of rotation changes", () => {
    const res = classifyAccountError(
      new Error('{"code":11140,"msg":"request illegal"}'),
      {
        origin: "upstream",
        scope: "account",
        credentialEvidence: true,
        providerCode: "11140",
        providerId: "openai",
        statusCode: 403,
      },
    );
    expect(res.category).not.toBe("policy_blocked");
    expect(res.status).not.toBe("disabled");
    expect(res.mutatesAccount).toBe(false);
  });

  test("does not mutate on local-origin quota signal", () => {
    const res = classifyAccountError(new Error("quota_exceeded: tenant budget exhausted"), {
      origin: "cartethyia",
      scope: "request",
      statusCode: 402,
    });
    expect(res.category).toBe("quota_exhausted");
    expect(res.mutatesAccount).toBe(false);
  });

  test("respects Retry-After header if provided", () => {
    const res = classifyAccountError(new Error("Too many requests"), {
      statusCode: 429,
      headers: { "retry-after": "120" },
    });
    expect(res.category).toBe("rate_limit_transient");
    expect(res.status).toBe("cooldown");
    expect(res.cooldownMs).toBe(120 * 1000);
  });

  test("parses retry-after header values", () => {
    expect(parseRetryAfter("60")).toBe(60 * 1000);
    expect(parseRetryAfter(null)).toBeNull();
  });
  test("classifies model capacity overloaded (503/529)", () => {
    const res = classifyAccountError(new Error("Overloaded with requests"), { statusCode: 503 });
    expect(res.category).toBe("model_capacity");
    expect(res.status).toBe("cooldown");
    expect(res.cooldownMs).toBe(2 * 60 * 1000);
  });

  test("does not mutate account state for Cartethyia-owned capacity errors", () => {
    const result = classifyAccountError(new Error("local capacity unavailable"), {
      origin: "cartethyia",
      scope: "request",
      statusCode: 503,
    });
    expect(result.category).toBe("model_capacity");
    expect(result.mutatesAccount).toBe(false);
  });

  test("an upstream invocation timeout degrades with a deadline instead of disabling", () => {
    // Provider-side "invocation timeout" / 504 shapes are transport faults: the
    // credential is fine, so the account must stay recoverable, never disabled.
    const res = classifyAccountError(new Error("Upstream invocation timeout after 300s"), {
      origin: "upstream",
      scope: "provider",
      credentialEvidence: true,
      statusCode: 504,
    });
    expect(res.category).toBe("timeout");
    expect(res.status).toBe("degraded");
    expect(res.status).not.toBe("disabled");
    expect(res.retryAt).not.toBeNull();
  });

  test("a failed hosted web_search tool call never disables the account", () => {
    // A hosted-tool failure (web_search/web_search_preview) is a per-request
    // tool outcome, not credential or quota evidence. It must not flip the
    // account to disabled even when the upstream reports it on a 403.
    const res = classifyAccountError(
      new Error("web_search tool invocation failed: search backend unavailable"),
      {
        origin: "upstream",
        scope: "provider",
        credentialEvidence: true,
        statusCode: 403,
      },
    );
    expect(res.status).not.toBe("disabled");
    expect(res.category).not.toBe("auth_invalidated");
  });

  test("an upstream 402 quota response cools the account down instead of disabling it", () => {
    const res = classifyAccountError(new Error("Payment Required"), {
      origin: "upstream",
      scope: "account",
      credentialEvidence: true,
      statusCode: 402,
    });
    expect(res.category).toBe("quota_exhausted");
    expect(res.status).toBe("cooldown");
    expect(res.retryAt).not.toBeNull();
  });
});
});

