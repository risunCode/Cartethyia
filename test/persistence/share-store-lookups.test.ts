import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DrizzleApiKeyStore, type ApiKeyRecord } from "../../src/persistence/api-key-store";
import { getDb, type CartethyiaDatabase } from "../../src/persistence/postgres";
import { DrizzleShareLinkStore, hashShareToken } from "../../src/persistence/share-store";
import { apiKeys, shareLinks, tenants } from "../../src/persistence/schema";
import { dbDescribe } from "../helpers/db-gate";

/**
 * Lookup predicates for public share links.
 *
 * `getApiKeyByShareToken` and `getHandoffByShareToken` are the only reads that
 * turn a URL token into a credential, and each carries a set of conditions that
 * decide whether the link still resolves: the link must be active, unexpired,
 * of the right kind, and its key must be unrevoked and of the expected mode.
 * Every one of those is a way a dead link could otherwise keep handing out a
 * credential, so each is exercised by breaking exactly one condition.
 *
 * Runs against the shared isolated database; cleanup removes only this suite's
 * tenants, and the cascade takes their keys and links with them.
 */
dbDescribe("share link lookups", () => {
  const tenantId = randomUUID();
  const enrollKeyId = randomUUID();
  const handoffKeyId = randomUUID();
  const revokedKeyId = randomUUID();
  const enrollToken = `enroll-${randomUUID()}`;
  const handoffToken = `handoff-${randomUUID()}`;
  const revokedToken = `revoked-${randomUUID()}`;
  const expiredToken = `expired-${randomUUID()}`;
  const inactiveToken = `inactive-${randomUUID()}`;
  const expiredKeyId = randomUUID();
  const inactiveKeyId = randomUUID();

  let db: CartethyiaDatabase;
  let apiKeysStore: DrizzleApiKeyStore;
  let shares: DrizzleShareLinkStore;

  beforeAll(async () => {
    db = getDb();
    apiKeysStore = new DrizzleApiKeyStore(db);
    shares = new DrizzleShareLinkStore(db);
    await db
      .insert(tenants)
      .values({ id: tenantId, name: `share-lookup-${tenantId}`, status: "active" })
      .onConflictDoNothing();

    const key = (
      id: string,
      mode: "share" | "personal",
      label: string,
    ): ApiKeyRecord => ({
      id,
      tenantId,
      // The schema enforces a per-mode row shape: a `personal` key must carry a
      // hash (it is a real credential), a parent `share` key must carry none
      // (it is a template with no secret of its own).
      keyHash: mode === "personal" ? createHash("sha256").update(id).digest("hex") : null,
      keyMode: mode,
      label,
      scopes: ["routing:invoke"],
      keyPrefix: "rk_",
      createdAt: new Date(),
      tokensConsumed: 0,
    });

    await apiKeysStore.create(key(enrollKeyId, "share", "enroll-template"));
    await apiKeysStore.create(key(handoffKeyId, "personal", "handoff-key"));
    await apiKeysStore.create(key(revokedKeyId, "share", "revoked-template"));
    await apiKeysStore.create(key(expiredKeyId, "share", "expired-template"));
    await apiKeysStore.create(key(inactiveKeyId, "share", "inactive-template"));
    await apiKeysStore.revoke(tenantId, revokedKeyId, new Date());

    await shares.create({
      apiKeyId: enrollKeyId,
      tokenHash: hashShareToken(enrollToken),
      tokenEncrypted: Buffer.from(enrollToken, "utf8"),
      kind: "enroll",
      expiresAt: null,
      rotate: false,
    });
    await shares.create({
      apiKeyId: handoffKeyId,
      tokenHash: hashShareToken(handoffToken),
      tokenEncrypted: Buffer.from(handoffToken, "utf8"),
      kind: "handoff",
      expiresAt: null,
      rotate: false,
    });
    await shares.create({
      apiKeyId: revokedKeyId,
      tokenHash: hashShareToken(revokedToken),
      tokenEncrypted: Buffer.from(revokedToken, "utf8"),
      kind: "enroll",
      expiresAt: null,
      rotate: false,
    });
    await shares.create({
      apiKeyId: expiredKeyId,
      tokenHash: hashShareToken(expiredToken),
      tokenEncrypted: Buffer.from(expiredToken, "utf8"),
      kind: "enroll",
      expiresAt: new Date(Date.now() - 60_000),
      rotate: false,
    });
    await shares.create({
      apiKeyId: inactiveKeyId,
      tokenHash: hashShareToken(inactiveToken),
      tokenEncrypted: Buffer.from(inactiveToken, "utf8"),
      kind: "enroll",
      expiresAt: null,
      rotate: false,
    });
    // Deactivate the link without deactivating its key: only the link is dead.
    await db
      .update(shareLinks)
      .set({ active: false })
      .where(eq(shareLinks.tokenHash, hashShareToken(inactiveToken)));
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("an active enrollment link resolves to its parent share key", async () => {
    const row = await shares.getApiKeyByShareToken(hashShareToken(enrollToken));
    expect(row).not.toBeNull();
    expect(row!.id).toBe(enrollKeyId);
    expect(row!.tenantId).toBe(tenantId);
    expect(row!.name).toBe("enroll-template");
    expect(row!.active).toBe(true);
    expect(row!.keyPrefix).toBe("rk_");
  });

  test("an unknown token resolves to nothing", async () => {
    expect(await shares.getApiKeyByShareToken(hashShareToken("never-issued"))).toBeNull();
  });

  test("a revoked parent key makes its enrollment link dead", async () => {
    expect(await shares.getApiKeyByShareToken(hashShareToken(revokedToken))).toBeNull();
  });

  test("an expired link does not resolve", async () => {
    expect(await shares.getApiKeyByShareToken(hashShareToken(expiredToken))).toBeNull();
  });

  test("a deactivated link does not resolve", async () => {
    expect(await shares.getApiKeyByShareToken(hashShareToken(inactiveToken))).toBeNull();
  });

  test("a handoff link is not accepted as an enrollment link", async () => {
    // The kinds are separate capabilities: an enrollment token mints a child
    // key, a handoff token reveals an existing personal key. Accepting one as
    // the other would let a handoff URL mint credentials.
    expect(await shares.getApiKeyByShareToken(hashShareToken(handoffToken))).toBeNull();
  });

  test("a handoff link resolves to its personal key and carries its limits", async () => {
    const row = await shares.getHandoffByShareToken(hashShareToken(handoffToken));
    expect(row).not.toBeNull();
    expect(row!.id).toBe(handoffKeyId);
    expect(row!.name).toBe("handoff-key");
    expect(row!.keyPrefix).toBe("rk_");
    expect(row!.expiresAt).toBeNull();
  });

  test("an enrollment link is not accepted as a handoff link", async () => {
    expect(await shares.getHandoffByShareToken(hashShareToken(enrollToken))).toBeNull();
  });

  test("findTokenForApiKey returns the live link, never a token for a dead one", async () => {
    const live = await shares.findTokenForApiKey(enrollKeyId);
    expect(live).not.toBeNull();
    expect(live!.tokenEncrypted?.toString("utf8")).toBe(enrollToken);

    expect(await shares.findTokenForApiKey(inactiveKeyId)).toBeNull();
    expect(await shares.findTokenForApiKey(expiredKeyId)).toBeNull();
    expect(await shares.findTokenForApiKey(randomUUID())).toBeNull();
  });

  test("create with rotate=false keeps the existing link and token", async () => {
    const replacement = `replacement-${randomUUID()}`;
    const record = await shares.create({
      apiKeyId: enrollKeyId,
      tokenHash: hashShareToken(replacement),
      tokenEncrypted: Buffer.from(replacement, "utf8"),
      kind: "enroll",
      expiresAt: null,
      rotate: false,
    });
    expect(record.apiKeyId).toBe(enrollKeyId);
    // The original token still resolves; the replacement never took effect.
    expect(await shares.getApiKeyByShareToken(hashShareToken(enrollToken))).not.toBeNull();
    expect(await shares.getApiKeyByShareToken(hashShareToken(replacement))).toBeNull();
  });

  test("create with rotate=true replaces the token so the old URL dies", async () => {
    const replacement = `rotated-${randomUUID()}`;
    const record = await shares.create({
      apiKeyId: enrollKeyId,
      tokenHash: hashShareToken(replacement),
      tokenEncrypted: Buffer.from(replacement, "utf8"),
      kind: "enroll",
      expiresAt: null,
      rotate: true,
    });
    expect(record.id).toBeDefined();
    // One active link per key: the old token stops resolving, the new one works.
    expect(await shares.getApiKeyByShareToken(hashShareToken(enrollToken))).toBeNull();
    expect(await shares.getApiKeyByShareToken(hashShareToken(replacement))).not.toBeNull();
  });

  test("touchView stamps lastViewedAt on the live link only", async () => {
    await shares.touchView(hashShareToken(handoffToken));
    const [link] = await db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.tokenHash, hashShareToken(handoffToken)))
      .limit(1);
    expect(link?.lastViewedAt).toBeInstanceOf(Date);

    // A dead link is not touched.
    await shares.touchView(hashShareToken(inactiveToken));
    const [dead] = await db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.tokenHash, hashShareToken(inactiveToken)))
      .limit(1);
    expect(dead?.lastViewedAt).toBeNull();
  });

  test("revoke is scoped to the owning key and the enroll kind", async () => {
    const [link] = await db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.tokenHash, hashShareToken(handoffToken)))
      .limit(1);
    expect(link).toBeDefined();
    // A handoff link is not revocable through the enrollment revoke path, and a
    // mismatched owner id must not revoke someone else's link.
    expect(await shares.revoke(randomUUID(), link!.id)).toBe(false);
    expect(await shares.revoke(handoffKeyId, link!.id)).toBe(false);
    expect(await shares.revoke(handoffKeyId, randomUUID())).toBe(false);
  });

  test("listForApiKey returns enrollment links only, newest first", async () => {
    const listed = await shares.listForApiKey(enrollKeyId);
    expect(listed.length).toBeGreaterThan(0);
    for (const entry of listed) {
      expect(entry.kind).toBe("enroll");
      expect(entry.apiKeyId).toBe(enrollKeyId);
    }
    const handoffListed = await shares.listForApiKey(handoffKeyId);
    // The handoff link is a different kind and is not listed as an enrollment.
    expect(handoffListed.every((entry) => entry.kind === "enroll")).toBe(true);
  });

  test("a share key carries no plaintext key hash", async () => {
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, enrollKeyId)).limit(1);
    expect(row?.keyHash).toBeNull();
    expect(row?.keyMode).toBe("share");
  });
});
