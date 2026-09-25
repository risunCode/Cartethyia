import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DrizzleApiKeyStore, type ApiKeyRecord } from "../../../src/persistence/api-key-store";
import { getDb, type CartethyiaDatabase } from "../../../src/persistence/postgres";
import { DrizzleShareLinkStore, hashShareToken } from "../../../src/persistence/share-store";
import { tenants } from "../../../src/persistence/schema";
import { canonicalClientIpKey } from "../../../src/security/ip-boundary";
import { dbDescribe } from "../../helpers/db-gate";

dbDescribe("shared API-key persistence", () => {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const parentIds = [randomUUID(), randomUUID()] as const;
  const tokens = [randomUUID() + randomUUID(), randomUUID() + randomUUID()] as const;
  const tokenAt = (index: number): string => {
    const token = tokens[index];
    if (token === undefined) throw new Error("missing test enrollment token");
    return token;
  };
  const ipNumber = Number.parseInt(tenantId.replaceAll("-", "").slice(0, 8), 16);
  const clientIp = [
    (ipNumber >>> 24) & 255,
    (ipNumber >>> 16) & 255,
    (ipNumber >>> 8) & 255,
    ipNumber & 255,
  ].join(".");
  const clientIpKey = canonicalClientIpKey(clientIp);
  let db: CartethyiaDatabase;
  let apiKeys: DrizzleApiKeyStore;
  let shares: DrizzleShareLinkStore;

  beforeAll(async () => {
    if (!clientIpKey) throw new Error("test IP did not canonicalize");
    db = getDb();
    apiKeys = new DrizzleApiKeyStore(db);
    shares = new DrizzleShareLinkStore(db);
    await db.insert(tenants).values([
      {
        id: tenantId,
        name: `shared-key-test-${tenantId}`,
        status: "active",
      },
      {
        id: otherTenantId,
        name: `shared-key-test-${otherTenantId}`,
        status: "active",
      },
    ]);
    for (const [index, id] of parentIds.entries()) {
      const parent: ApiKeyRecord = {
        id,
        tenantId: index === 0 ? tenantId : otherTenantId,
        keyHash: null,
        keyMode: "share",
        label: `template-${index}`,
        scopes: ["routing:invoke"],
        keyPrefix: "rk_",
        createdAt: new Date(),
        tokensConsumed: 0,
      };
      await apiKeys.create(parent);
      await shares.create({
        apiKeyId: id,
        tokenHash: hashShareToken(tokenAt(index)),
        expiresAt: null,
      });
    }
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await db.delete(tenants).where(eq(tenants.id, otherTenantId));
  });

  test("one canonical IP races globally and parent revoke/conversion releases it", async () => {
    if (!clientIpKey) throw new Error("test IP did not canonicalize");
    const attempts = await Promise.all(
      tokens.map((token, index) =>
        shares.issueSharedApiKey(hashShareToken(token), {
          keyHash: createHash("sha256").update(`shared-child-${index}-initial`).digest("hex"),
          keyPrefix: "rk_",
          clientIp,
          clientIpKey,
        }),
      ),
    );
    const issued = attempts.find((result) => result.kind === "issued");
    expect(attempts.filter((result) => result.kind === "issued")).toHaveLength(1);
    expect(attempts.filter((result) => result.kind === "ip_limit")).toHaveLength(1);
    if (!issued || issued.kind !== "issued") throw new Error("expected one issued child key");

    expect(await shares.hasActiveSharedKeyForIp(clientIpKey)).toBe(true);
    const issuedTenantId = issued.parentKeyId === parentIds[0] ? tenantId : otherTenantId;
    expect(await apiKeys.revoke(issuedTenantId, issued.parentKeyId, new Date())).toBe(true);
    const revokedChildren = await apiKeys.listChildren(issuedTenantId, issued.parentKeyId);
    expect(revokedChildren).toHaveLength(1);
    expect(revokedChildren[0]?.revokedAt).toBeInstanceOf(Date);
    expect(await shares.hasActiveSharedKeyForIp(clientIpKey)).toBe(false);

    const remainingIndex = issued.parentKeyId === parentIds[0] ? 1 : 0;
    const retried = await shares.issueSharedApiKey(
      hashShareToken(tokenAt(remainingIndex)),
      {
        keyHash: createHash("sha256").update("shared-child-after-parent-revoke").digest("hex"),
        keyPrefix: "rk_",
        clientIp,
        clientIpKey,
      },
    );
    expect(retried.kind).toBe("issued");
    expect(await shares.hasActiveSharedKeyForIp(clientIpKey)).toBe(true);
    if (retried.kind !== "issued") throw new Error("expected enrollment after parent revoke");
    const retriedTenantId = remainingIndex === 0 ? tenantId : otherTenantId;
    const converted = await apiKeys.update(retriedTenantId, retried.parentKeyId, {
      keyMode: "personal",
      keyHash: createHash("sha256").update("converted-personal-key").digest("hex"),
      keyEncrypted: null,
      keyPrefix: "rk_",
    });
    expect(converted?.keyMode).toBe("personal");
    const convertedChildren = await apiKeys.listChildren(retriedTenantId, retried.parentKeyId);
    expect(convertedChildren).toHaveLength(1);
    expect(convertedChildren[0]?.revokedAt).toBeInstanceOf(Date);
    expect((await shares.listForApiKey(retried.parentKeyId))[0]?.active).toBe(false);
    expect(await shares.hasActiveSharedKeyForIp(clientIpKey)).toBe(false);
  });
});
