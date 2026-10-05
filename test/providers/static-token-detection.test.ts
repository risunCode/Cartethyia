/**
 * Automatic static-token detection.
 *
 * An OAuth account whose refresh grant is rejected definitively is not
 * necessarily dead: the access token it already holds may still be well inside
 * its own validity. The gateway must then stop trying to refresh it and keep
 * serving it as a *static* token — without changing `credentialKind`, which
 * stays `oauth` — while an account whose access token cannot be shown to work
 * is parked for re-auth. These tests hold both outcomes, plus the two
 * non-cases: a healthy refresh stays refreshable, and an API-key account is
 * static by nature and never enters this path at all.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/persistence/postgres";
import { providerAccounts, providerOauthStates } from "../../src/persistence/schema";
import { encryptCredential, decryptCredentialToString } from "../../src/security/crypto";
import {
  OAuthRefreshService,
  reconcileStaticTokenAccounts,
  type OAuthTokenRefresher,
} from "../../src/providers/authentication/oauth-refresh-service";
import { classifyAccessTokenUsability } from "../../src/providers/authentication/static-token-detection";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe } from "../helpers/database";

/** A structurally valid compact JWS whose signature is a placeholder. */
function jwt(expSecondsFromNow: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  // `jti` keeps two tokens minted in the same second distinct, so the account
  // identity index (provider, tenant, credential fingerprint) never collides.
  const payload = Buffer.from(
    JSON.stringify({ exp, sub: "acct", jti: randomUUID() }),
  ).toString("base64url");
  return `${header}.${payload}.c2ln`;
}

/** A refresher whose refresh grant is definitively dead. */
function revokedRefresher(): OAuthTokenRefresher {
  return {
    refresh: () => Promise.reject(new Error("invalid_grant: refresh token revoked")),
  };
}

/** A refresher that succeeds and mints a fresh access token. */
function healthyRefresher(): OAuthTokenRefresher {
  return {
    refresh: async () => ({
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
  };
}

describe("classifyAccessTokenUsability", () => {
  test("a JWT comfortably inside its validity is usable", () => {
    expect(classifyAccessTokenUsability(jwt(3_600))).toBe("usable");
  });

  test("an expired JWT is expired", () => {
    expect(classifyAccessTokenUsability(jwt(-3_600))).toBe("expired");
  });

  test("a JWT about to lapse inside the skew is not yet usable", () => {
    expect(classifyAccessTokenUsability(jwt(60))).toBe("expired");
  });

  test("an opaque or missing token cannot be shown to work", () => {
    expect(classifyAccessTokenUsability("opaque-bearer-token")).toBe("undecodable");
    expect(classifyAccessTokenUsability(undefined)).toBe("undecodable");
    expect(classifyAccessTokenUsability("")).toBe("undecodable");
  });
});

dbDescribe("OAuth refresh: automatic static-token detection", () => {
  let world: GatewayWorld;
  const db = getDb();

  beforeAll(async () => {
    world = await createWorld();
  });

  afterAll(async () => {
    await world?.cleanup();
  });

  /** Creates an OAuth account with a stored refresh token and the given access token. */
  async function oauthAccount(accessToken: string): Promise<string> {
    const accountId = await world.addAccount({
      credentialKind: "oauth",
      credential: accessToken,
    });
    await db.insert(providerOauthStates).values({
      providerAccountId: accountId,
      refreshCiphertext: encryptCredential("stored-refresh-token"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return accountId;
  }

  async function readAccount(accountId: string) {
    const rows = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("account vanished");
    return row;
  }

  test("a definitive refresh failure with a still-valid access token becomes static", async () => {
    const accountId = await oauthAccount(jwt(3_600));
    const service = new OAuthRefreshService(db);
    const result = await service.ensureFreshAccessToken(accountId, revokedRefresher(), {
      force: true,
    });
    expect(result).toBeNull();
    const row = await readAccount(accountId);
    expect(row.staticToken).toBe(true);
    // Static is a mode of an OAuth account, never a reclassification of it.
    expect(row.credentialKind).toBe("oauth");
    // It is usable exactly as issued, so it must read healthy, not broken.
    expect(row.status).toBe("active");
    expect(row.lastErrorCategory).toBeNull();
  });

  test("a definitive refresh failure with an unusable access token is parked for re-auth", async () => {
    const accountId = await oauthAccount(jwt(-3_600));
    const service = new OAuthRefreshService(db);
    await service.ensureFreshAccessToken(accountId, revokedRefresher(), { force: true });
    const row = await readAccount(accountId);
    expect(row.staticToken).toBe(false);
    expect(row.status).toBe("disabled");
    expect(row.lastErrorCategory).toBe("auth_invalidated");
  });

  test("an opaque access token is treated as unusable and parked for re-auth", async () => {
    const accountId = await oauthAccount("opaque-no-expiry");
    const service = new OAuthRefreshService(db);
    await service.ensureFreshAccessToken(accountId, revokedRefresher(), { force: true });
    const row = await readAccount(accountId);
    expect(row.staticToken).toBe(false);
    expect(row.status).toBe("disabled");
  });

  test("a successful refresh stays refreshable and is not marked static", async () => {
    const accountId = await oauthAccount(jwt(3_600));
    const service = new OAuthRefreshService(db);
    const access = await service.ensureFreshAccessToken(accountId, healthyRefresher(), {
      force: true,
    });
    expect(access).toBe("fresh-access-token");
    const row = await readAccount(accountId);
    expect(row.staticToken).toBe(false);
    expect(row.status).toBe("active");
    expect(decryptCredentialToString(row.credentialCiphertext!)).toBe("fresh-access-token");
  });

  test("an API-key account never enters the refresh path", async () => {
    const accountId = await world.addAccount({ credentialKind: "api_key" });
    const service = new OAuthRefreshService(db);
    const result = await service.ensureFreshAccessToken(accountId, revokedRefresher(), {
      force: true,
    });
    expect(result).toBeNull();
    const row = await readAccount(accountId);
    expect(row.staticToken).toBe(false);
    expect(row.status).toBe("active");
  });

  test("the boot pass recovers an account parked by an earlier build", async () => {
    // The shape the previous build wrote: disabled, `oauth_revoked`, access
    // token still valid. Detection did not exist then; the boot pass is how
    // such a row converges without an operator touching it.
    const recoverable = await oauthAccount(jwt(3_600));
    await db
      .update(providerAccounts)
      .set({ status: "disabled", lastErrorCategory: "oauth_revoked" })
      .where(eq(providerAccounts.id, recoverable));

    // A genuinely dead credential converges the other way: legacy category
    // renamed to the one the console renders as "Re-login required".
    const dead = await oauthAccount(jwt(-3_600));
    await db
      .update(providerAccounts)
      .set({ status: "disabled", lastErrorCategory: "oauth_revoked" })
      .where(eq(providerAccounts.id, dead));

    await reconcileStaticTokenAccounts(db);

    const recovered = await readAccount(recoverable);
    expect(recovered.staticToken).toBe(true);
    expect(recovered.status).toBe("active");
    const parked = await readAccount(dead);
    expect(parked.staticToken).toBe(false);
    expect(parked.status).toBe("disabled");
    expect(parked.lastErrorCategory).toBe("auth_invalidated");
  });
});
