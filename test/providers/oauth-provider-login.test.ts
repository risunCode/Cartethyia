/**
 * The login side of the three OAuth-shaped providers, exercised against a stub
 * WorkOS/gateway/model-list rather than the real services.
 *
 * What these pin, per provider:
 *
 * - **factory-droid** — the device grant runs, and the token's JWT claims become
 *   the stored envelope. The org claim is the case that matters: without it the
 *   dispatch path refuses the credential, so a login that persisted a bare
 *   bearer would produce an account that cannot make a request.
 * - **cloudflare-ai-gateway / alibaba-coding-plan** — the import flow validates
 *   against the *chosen* host, and neither registers a refresher, because neither
 *   upstream publishes a refresh grant.
 */
import { describe, expect, test } from "bun:test";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import { FactoryDroidOAuthClient } from "../../src/providers/integrations/factory-droid/factory-droid-oauth";
import { decodeFactoryDroidCredential } from "../../src/security/credential-codec";

/** Builds an unsigned JWT whose payload is `claims`. Only the claims are read. */
function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

interface StubCall {
  readonly url: string;
  readonly body: string;
}

function stubFetch(
  handler: (call: StubCall) => Response,
): { fetch: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), body: String(init?.body ?? "") };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetch: fetcher, calls };
}

const ACCESS = jwt({
  sub: "user_01",
  email: "dev@example.com",
  external_org_id: "org_123",
  exp: 1_800_000_000,
});

describe("factory-droid device login", () => {
  test("completes the grant and stores the token with its org claim", async () => {
    const { fetch: fetcher } = stubFetch(() =>
      Response.json({ access_token: ACCESS, refresh_token: "workos-refresh" }),
    );
    const client = new FactoryDroidOAuthClient(fetcher);

    const pending = await client.pollDeviceAuth("device-code-1");
    expect(pending.status).toBe("complete");
    if (pending.status !== "complete") throw new Error("unreachable");

    const envelope = decodeFactoryDroidCredential(pending.result.access);
    expect(envelope.accessToken).toBe(ACCESS);
    // The claim the dispatch path sends as X-Factory-Org-Id. Persisting a bare
    // bearer here would leave an account that fails every request.
    expect(envelope.orgId).toBe("org_123");
  });

  test("records the refresh grant rather than mirroring the access token", async () => {
    const { fetch: fetcher } = stubFetch(() =>
      Response.json({ access_token: ACCESS, refresh_token: "workos-refresh" }),
    );
    const client = new FactoryDroidOAuthClient(fetcher);
    const result = await client.pollDeviceAuth("device-code-1");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.result.refresh).toBe("workos-refresh");
  });

  test("records the approving user so the console can label the account", async () => {
    const { fetch: fetcher } = stubFetch(() => Response.json({ access_token: ACCESS }));
    const client = new FactoryDroidOAuthClient(fetcher);
    const result = await client.pollDeviceAuth("device-code-1");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.result.accountLabel).toBe("dev@example.com");
    expect(result.result.auth_state?.["userId"]).toBe("user_01");
  });

  test("expires with the token rather than at a fixed far-future date", async () => {
    const { fetch: fetcher } = stubFetch(() => Response.json({ access_token: ACCESS }));
    const client = new FactoryDroidOAuthClient(fetcher);
    const result = await client.pollDeviceAuth("device-code-1");
    if (result.status !== "complete") throw new Error("expected complete");
    // A far-future expiry would make the freshness check treat a dead token as
    // live and never schedule the refresh that would fix it.
    expect(result.result.expiresAt.getTime()).toBe(1_800_000_000_000);
  });

  test("refuses a token with no organization claim", async () => {
    const { fetch: fetcher } = stubFetch(() =>
      Response.json({ access_token: jwt({ sub: "user_01" }) }),
    );
    const client = new FactoryDroidOAuthClient(fetcher);
    const result = await client.pollDeviceAuth("device-code-1");
    if (result.status !== "failed") throw new Error("expected failure");
    expect(result.reason).toMatch(/organization claim/);
  });

  test("keeps polling while the operator has not approved yet", async () => {
    const { fetch: fetcher } = stubFetch(() =>
      Response.json({ error: "authorization_pending" }, { status: 400 }),
    );
    const client = new FactoryDroidOAuthClient(fetcher);
    const result = await client.pollDeviceAuth("device-code-1");
    expect(result.status).toBe("pending");
  });

  test("refreshes against the same WorkOS token endpoint", async () => {
    const { fetch: fetcher, calls } = stubFetch(() =>
      Response.json({ access_token: ACCESS, refresh_token: "workos-refresh" }),
    );
    const client = new FactoryDroidOAuthClient(fetcher);
    const refreshed = await client.refresh("workos-refresh");
    expect(calls[0]?.url).toBe("https://api.workos.com/user_management/authenticate");
    expect(calls[0]?.body).toContain("refresh_token");
    // The refreshed credential is again a full envelope: a refresh that stored
    // the raw token would strip the org claim the next dispatch needs.
    expect(decodeFactoryDroidCredential(refreshed.access).orgId).toBe("org_123");
  });
});

describe("registry refresher registration", () => {
  const registry = createDefaultProviderRegistry();

  async function hasRefresher(providerId: string): Promise<boolean> {
    const refresher = await registry.resolveRefresher(providerId);
    return refresher !== undefined;
  }

  test("factory-droid registers a refresher", async () => {
    // WorkOS re-authenticates against the same endpoint, so the grant is real;
    // omitting it would make an expired access token a dead account.
    expect((await hasRefresher("factory-droid"))).toBe(true);
  });

  test("cloudflare-ai-gateway registers no refresher", async () => {
    // A gateway token is durable. A refresher here would call a method that
    // always throws, turning a recoverable 401 into a permanent one.
    expect((await hasRefresher("cloudflare-ai-gateway"))).toBe(false);
  });

  test("alibaba-coding-plan registers no refresher", async () => {
    expect((await hasRefresher("alibaba-coding-plan"))).toBe(false);
  });

  test("the console login fields carry what each import needs", async () => {
    const { cloudflareAiGatewayOAuthClient } = await import(
      "../../src/providers/integrations/cloudflare-ai-gateway/cloudflare-ai-gateway-oauth"
    );
    const { alibabaCodingPlanOAuthClient } = await import(
      "../../src/providers/integrations/alibaba-coding-plan/alibaba-coding-plan-oauth"
    );
    // Without these the console renders a bare key input and the stored
    // envelope would be missing a field the base URL is built from.
    expect(cloudflareAiGatewayOAuthClient.importFields?.map((f) => f.key)).toEqual([
      "accountId",
      "gatewayId",
    ]);
    expect(alibabaCodingPlanOAuthClient.importFields?.map((f) => f.key)).toEqual(["region"]);
  });
});