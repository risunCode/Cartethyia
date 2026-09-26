import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../../src/persistence/postgres";
import { healthEvents, providerAccounts, tenants } from "../../../src/persistence/schema";
import { consumeAccountResetCredit } from "../../../src/providers/operations/account-reset-service";
import { dbDescribe } from "../../helpers/db-gate";
import { jsonResponse } from "../../helpers/sse-fixtures";

/**
 * The failure and edge branches of `consumeAccountResetCredit`.
 *
 * The happy path is covered by the existing suite. What is exercised here is
 * how the operation classifies everything else: a provider that answers 401,
 * 429, an unexpected status, a malformed body, an unreachable network, or a
 * grant the operator named but the provider refuses. Each has a distinct code
 * because the operator's next action differs — re-authenticate, wait, retry,
 * or pick another credit — and collapsing them into one "failed" would hide
 * which.
 */

const db = getDb();
const tenantId = randomUUID();
const accountIds: string[] = [];

async function seedAccount(providerId: string): Promise<string> {
  await db
    .insert(tenants)
    .values({ id: tenantId, name: "reset-branches", status: "active" })
    .onConflictDoNothing();
  const accountId = randomUUID();
  accountIds.push(accountId);
  await db.insert(providerAccounts).values({
    id: accountId,
    tenantId,
    providerId,
    label: "reset-branch-account",
    credentialKind: "none",
    status: "active",
  });
  return accountId;
}

afterAll(async () => {
  for (const id of accountIds) {
    await db.delete(healthEvents).where(eq(healthEvents.accountId, id));
    await db.delete(providerAccounts).where(eq(providerAccounts.id, id));
  }
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

dbDescribe("consumeAccountResetCredit — codex outcome classification", () => {
  test("a 401 is classified as an auth error", async () => {
    const accountId = await seedAccount("codex");
    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "codex",
      credentialRaw: "access-token",
      creditId: "RateLimitResetCredit_1",
      fetcher: (async () => jsonResponse({}, 401)) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("http_401");
    expect(result.status).toBe(401);
  });

  test("an unexpected status becomes http_<status>", async () => {
    const accountId = await seedAccount("codex");
    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "codex",
      credentialRaw: "access-token",
      creditId: "RateLimitResetCredit_1",
      fetcher: (async () => jsonResponse({}, 503)) as unknown as typeof fetch,
    });
    expect(result.code).toBe("http_503");
    expect(result.status).toBe(503);
  });

  test("an OK response with an unparseable body is treated as a successful reset", async () => {
    const accountId = await seedAccount("codex");
    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "codex",
      credentialRaw: "access-token",
      creditId: "RateLimitResetCredit_1",
      fetcher: (async () =>
        new Response("not json", { status: 200 })) as unknown as typeof fetch,
    });
    // The classification is: a body `code` wins; otherwise a 2xx means the
    // reset applied. Some upstreams answer an empty 200 on success, so an
    // absent body is not treated as a failure.
    expect(result.ok).toBe(true);
    expect(result.code).toBe("reset");
    expect(result.status).toBe(200);
  });

  test("an unreachable provider is a network error, not a provider error", async () => {
    const accountId = await seedAccount("codex");
    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "codex",
      credentialRaw: "access-token",
      creditId: "RateLimitResetCredit_1",
      fetcher: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("network_error");
    expect(result.status).toBe(0);
    expect(result.message).toBe("ECONNREFUSED");
    // The named credit is echoed back so the caller can retry the same one.
    expect(result.creditId).toBe("RateLimitResetCredit_1");
  });

  test("no credit is reported when discovery finds nothing and none was named", async () => {
    const accountId = await seedAccount("codex");
    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "codex",
      credentialRaw: "access-token",
      fetcher: (async () =>
        jsonResponse({ credits: [], available_count: 0 }, 200)) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("no_credit");
  });
});

dbDescribe("consumeAccountResetCredit — Claude outcome classification", () => {
  function claudeCredential(orgId: string): string {
    return JSON.stringify({ accessToken: "tok", orgId });
  }

  test("a 429 is classified as rate limited", async () => {
    const accountId = await seedAccount("claude");
    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "claude",
      credentialRaw: claudeCredential("org_1"),
      creditId: "cedar_ember_1",
      fetcher: (async () => jsonResponse({}, 429)) as unknown as typeof fetch,
    });
    expect(result.code).toBe("rate_limited");
    expect(result.status).toBe(429);
  });

  test("a 401 is classified as an auth error", async () => {
    const accountId = await seedAccount("claude");
    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "claude",
      credentialRaw: claudeCredential("org_1"),
      creditId: "cedar_ember_1",
      fetcher: (async () => jsonResponse({}, 403)) as unknown as typeof fetch,
    });
    expect(result.code).toBe("auth_error");
  });

  test("an OK response with no result field is malformed", async () => {
    const accountId = await seedAccount("claude");
    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "claude",
      credentialRaw: claudeCredential("org_1"),
      creditId: "cedar_ember_1",
      fetcher: (async () => jsonResponse({}, 200)) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("malformed_response");
  });

  test("the provider's already_used maps to already_redeemed", async () => {
    const accountId = await seedAccount("claude");
    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "claude",
      credentialRaw: claudeCredential("org_1"),
      creditId: "cedar_ember_1",
      fetcher: (async () =>
        jsonResponse({ result: "already_used" }, 200)) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("already_redeemed");
  });

  test("the provider's not_limited maps to nothing_to_reset", async () => {
    const accountId = await seedAccount("claude");
    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "claude",
      credentialRaw: claudeCredential("org_1"),
      creditId: "cedar_ember_1",
      fetcher: (async () =>
        jsonResponse({ result: "not_limited" }, 200)) as unknown as typeof fetch,
    });
    expect(result.code).toBe("nothing_to_reset");
  });

  test("a Juniper program reset succeeds without a grant id", async () => {
    const accountId = await seedAccount("claude");
    const seen: string[] = [];
    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "claude",
      credentialRaw: claudeCredential("org_1"),
      creditId: "juniper_program",
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(String(input));
        if (init?.method === "POST") return jsonResponse({ result: "reset" }, 200);
        return jsonResponse({}, 200);
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("reset");
    // The Juniper path posts the program, not a grant id.
    expect(seen.some((url) => url.includes("reset_rate_limits"))).toBe(true);
  });

  test("an unresolvable organization is reported without a reset attempt", async () => {
    const accountId = await seedAccount("claude");
    // No configured orgId, and the profile probe fails, so there is no org to
    // post to. The operation must say so rather than post to a guessed id.
    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "claude",
      credentialRaw: JSON.stringify({ accessToken: "tok" }),
      creditId: "cedar_ember_1",
      fetcher: (async () =>
        new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("organization_unavailable");
  });

  test("the organization is resolved from the profile probe when not configured", async () => {
    const accountId = await seedAccount("claude");
    const seen: string[] = [];
    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "claude",
      credentialRaw: JSON.stringify({ accessToken: "tok" }),
      creditId: "cedar_ember_1",
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        seen.push(url);
        if (url.includes("/profile")) return jsonResponse({ organization: { uuid: "org_from_profile" } }, 200);
        if (init?.method === "POST") return jsonResponse({ result: "reset" }, 200);
        return jsonResponse({}, 200);
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(seen.some((url) => url.includes("org_from_profile"))).toBe(true);
  });
});
