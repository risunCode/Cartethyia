import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../../src/persistence/postgres";
import { healthEvents, providerAccounts, tenants } from "../../../src/persistence/schema";
import { dbDescribe } from "../../helpers/db-gate";
import {
  consumeAccountResetCredit,
  listAccountResetCredits,
  pickSoonestExpiringCredit,
  supportsAccountReset,
} from "../../../src/providers/operations/account-reset-service";
import { jsonResponse } from "../../helpers/sse-fixtures";


describe("supportsAccountReset", () => {
  test("accepts the Codex and Claude families", () => {
    expect(supportsAccountReset("codex")).toBe(true);
    expect(supportsAccountReset("claude")).toBe(true);
    expect(supportsAccountReset("anthropic")).toBe(true);
    expect(supportsAccountReset("  Claude ")).toBe(true);
  });

  test("rejects providers without reset support", () => {
    expect(supportsAccountReset("openai")).toBe(false);
    expect(supportsAccountReset("workbuddy")).toBe(false);
  });
});

describe("pickSoonestExpiringCredit", () => {
  test("prefers the available credit that expires soonest", () => {
    const picked = pickSoonestExpiringCredit([
      { id: "late", status: "available", expiresAt: "2030-02-01T00:00:00Z" },
      { id: "soon", status: "available", expiresAt: "2030-01-01T00:00:00Z" },
      { id: "used", status: "redeemed", expiresAt: "2029-01-01T00:00:00Z" },
    ]);
    expect(picked?.id).toBe("soon");
  });

  test("ranks undated available credits after dated ones", () => {
    const picked = pickSoonestExpiringCredit([
      { id: "undated", status: "available" },
      { id: "dated", status: "available", expiresAt: "2030-01-01T00:00:00Z" },
    ]);
    expect(picked?.id).toBe("dated");
  });

  test("falls back to the first credit when nothing is available", () => {
    const picked = pickSoonestExpiringCredit([{ id: "only", status: "redeemed" }]);
    expect(picked?.id).toBe("only");
  });
});

describe("listAccountResetCredits — Codex", () => {
  test("parses credits and honors the backend's available_count", async () => {
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/wham/rate-limit-reset-credits");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer access-token");
      expect(headers.get("User-Agent")).toMatch(/^codex_cli_rs\//);
      return jsonResponse({
        credits: [
          {
            id: "RateLimitResetCredit_1",
            status: "available",
            title: "One free rate limit reset",
            granted_at: "2026-09-01T00:00:00Z",
            expires_at: "2030-01-01T00:00:00Z",
          },
          { id: "RateLimitResetCredit_2", status: "redeemed" },
        ],
        available_count: 1,
      });
    }) as unknown as typeof fetch;

    const list = await listAccountResetCredits("codex", "access-token", fetcher);
    expect(list?.availableCount).toBe(1);
    expect(list?.credits).toHaveLength(2);
    expect(list?.credits[0]).toEqual({
      id: "RateLimitResetCredit_1",
      status: "available",
      title: "One free rate limit reset",
      grantedAt: "2026-09-01T00:00:00Z",
      expiresAt: "2030-01-01T00:00:00Z",
    });
  });

  test("derives availableCount from statuses when the backend omits it", async () => {
    const fetcher = (async () =>
      jsonResponse({
        credits: [{ id: "c1", status: "available" }, { id: "c2", status: "redeemed" }],
      })) as unknown as typeof fetch;
    const list = await listAccountResetCredits("codex", "access-token", fetcher);
    expect(list?.availableCount).toBe(1);
  });

  test("returns null on a non-OK response", async () => {
    const failing = (async () => jsonResponse({}, 500)) as unknown as typeof fetch;
    expect(await listAccountResetCredits("codex", "access-token", failing)).toBeNull();
  });
});

describe("listAccountResetCredits — Claude", () => {
  test("parses cedar_ember grants and counts unexpired resets_left", async () => {
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/api/oauth/usage");
      expect(String(input)).toContain("cedar_ember=1");
      const headers = new Headers(init?.headers);
      expect(headers.get("User-Agent")).toMatch(/^claude-cli\//);
      return jsonResponse({
        cedar_ember: {
          eligible: true,
          next_grant_id: "grant_a",
          grants: [
            {
              id: "grant_a",
              label: "One free rate limit reset",
              resets_left: 2,
              usable_now: true,
              starts_at: "2026-09-01T00:00:00Z",
              ends_at: "2030-01-02T00:00:00Z",
            },
            { id: "grant_b", resets_left: 0 },
          ],
        },
      });
    }) as unknown as typeof fetch;

    const list = await listAccountResetCredits("claude", "access-token", fetcher);
    expect(list?.availableCount).toBe(2);
    expect(list?.credits[0]).toEqual({
      id: "grant_a",
      title: "One free rate limit reset",
      status: "available",
      grantedAt: "2026-09-01T00:00:00Z",
      expiresAt: "2030-01-02T00:00:00Z",
    });
    expect(list?.credits[1]).toEqual({ id: "grant_b", title: "Claude limit reset", status: "redeemed" });
  });

  test("marks a non-selected grant unavailable", async () => {
    const fetcher = (async () =>
      jsonResponse({
        cedar_ember: {
          eligible: true,
          next_grant_id: "grant_a",
          grants: [
            { id: "grant_a", resets_left: 1, usable_now: true },
            { id: "grant_b", resets_left: 1, usable_now: true },
          ],
        },
      })) as unknown as typeof fetch;
    const list = await listAccountResetCredits("claude", "access-token", fetcher);
    expect(list?.credits.find((c) => c.id === "grant_b")?.status).toBe("unavailable");
    expect(list?.credits.find((c) => c.id === "grant_a")?.status).toBe("available");
  });

  test("falls through to the Juniper at-wall probe when Cedar answers empty", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).includes("cedar_ember=1")) {
        return jsonResponse({ cedar_ember: { eligible: true, grants: [] } });
      }
      expect(String(input)).toContain("at_wall=1");
      return jsonResponse({
        juniper_tide: { eligible: true, arm: "reset", available: true },
      });
    }) as unknown as typeof fetch;

    const list = await listAccountResetCredits("claude", "access-token", fetcher);
    expect(calls).toHaveLength(2);
    expect(list?.availableCount).toBe(1);
    expect(list?.credits[0]?.id).toBe("juniper_tide");
  });

  test("returns null when the credential cannot reach discovery", async () => {
    const failing = (async () => jsonResponse({}, 500)) as unknown as typeof fetch;
    expect(await listAccountResetCredits("claude", "access-token", failing)).toBeNull();
  });
});

describe("listAccountResetCredits — unsupported", () => {
  test("returns null without a network call", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    expect(await listAccountResetCredits("openai", "token", fetcher)).toBeNull();
    expect(called).toBe(false);
  });
});

describe("consumeAccountResetCredit — unsupported", () => {
  test("rejects an unsupported provider before touching the database", async () => {
    const result = await consumeAccountResetCredit({
      db: {} as never,
      accountId: randomUUID(),
      providerId: "openai",
      credentialRaw: "token",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("unsupported_provider");
    expect(result.status).toBe(400);
  });

  test("rejects a malformed Claude grant id without a network call", async () => {
    const fetcher = (async () => {
      throw new Error("network must not be reached");
    }) as unknown as typeof fetch;
    const result = await consumeAccountResetCredit({
      db: {} as never,
      accountId: randomUUID(),
      providerId: "claude",
      credentialRaw: JSON.stringify({ accessToken: "tok", orgId: "org_1" }),
      creditId: "NOT A GRANT ID!",
      fetcher,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_credit");
    expect(result.status).toBe(400);
  });
});

dbDescribe("consumeAccountResetCredit — persistence", () => {
  const db = getDb();
  const tenantId = randomUUID();
  const accountIds: string[] = [];

  async function seedAccount(status: "active" | "cooldown"): Promise<string> {
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "reset-test", status: "active" })
      .onConflictDoNothing();
    const accountId = randomUUID();
    accountIds.push(accountId);
    await db.insert(providerAccounts).values({
      id: accountId,
      tenantId,
      providerId: "codex",
      label: "reset-account",
      credentialKind: "none",
      status,
      consecutiveFailures: 3,
      cooldownUntil: new Date(Date.now() + 60_000),
    });
    return accountId;
  }

  test("a successful reset recovers the account and logs an active health event", async () => {
    const accountId = await seedAccount("cooldown");
    const fetcher = (async () =>
      jsonResponse({ code: "reset" }, 200)) as unknown as typeof fetch;

    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "codex",
      credentialRaw: "access-token",
      creditId: "RateLimitResetCredit_1",
      fetcher,
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("reset");

    const account = (
      await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId))
    )[0];
    expect(account?.status).toBe("active");
    expect(account?.consecutiveFailures).toBe(0);
    expect(account?.cooldownUntil).toBeNull();

    const events = await db.select().from(healthEvents).where(eq(healthEvents.accountId, accountId));
    expect(events).toHaveLength(1);
    expect(events[0]?.toStatus).toBe("active");
    expect(events[0]?.fromStatus).toBe("cooldown");
    expect(events[0]?.reason).toContain("Rate limit reset consumed");
  });

  test("a failed reset logs the code without changing account status", async () => {
    const accountId = await seedAccount("active");
    const fetcher = (async () =>
      jsonResponse({ code: "nothing_to_reset" }, 200)) as unknown as typeof fetch;

    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "codex",
      credentialRaw: "access-token",
      creditId: "RateLimitResetCredit_1",
      fetcher,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("nothing_to_reset");

    const account = (
      await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId))
    )[0];
    expect(account?.status).toBe("active");

    const events = await db.select().from(healthEvents).where(eq(healthEvents.accountId, accountId));
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toContain("Rate limit reset failed: [nothing_to_reset]");
    expect(events[0]?.errorCategory).toBe("nothing_to_reset");
  });

  test("auto-selects the soonest-expiring credit when none is named", async () => {
    const accountId = await seedAccount("active");
    const seen: string[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { credit_id: string };
        seen.push(body.credit_id);
        return jsonResponse({ code: "reset" }, 200);
      }
      return jsonResponse({
        credits: [
          { id: "later", status: "available", expires_at: "2030-06-01T00:00:00Z" },
          { id: "sooner", status: "available", expires_at: "2030-01-01T00:00:00Z" },
        ],
        available_count: 2,
      });
    }) as unknown as typeof fetch;

    const result = await consumeAccountResetCredit({
      db,
      accountId,
      providerId: "codex",
      credentialRaw: "access-token",
      fetcher,
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["sooner"]);
  });

  afterAll(async () => {
    for (const id of accountIds) {
      await db.delete(providerAccounts).where(eq(providerAccounts.id, id));
    }
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });
});
