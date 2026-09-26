import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../../src/persistence/postgres";
import { apiKeys, tenants } from "../../../src/persistence/schema";
import { DrizzleCliToolSecretSource } from "../../../src/console/cli-tools/secret-source";
import {
  encryptCredential,
  hashSecret,
  setCredentialEncryptionKeyForTesting,
} from "../../../src/security/crypto";
import { dbDescribe } from "../../helpers/db-gate";

/**
 * The CLI-tool secret reader.
 *
 * This is the one place the console turns a stored key back into plaintext, so
 * the properties that keep that from widening exposure are what the suite
 * pins: every lookup is tenant-scoped (one tenant's session can never resolve
 * another tenant's key), a revoked key resolves to nothing, and a key stored
 * before `key_encrypted` existed has no recoverable copy and correctly yields
 * `undefined` rather than a fabricated secret.
 */
dbDescribe("DrizzleCliToolSecretSource", () => {
  let db: CartethyiaDatabase;
  let source: DrizzleCliToolSecretSource;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const PLAINTEXT = "ctk_live_secret_value_1234567890";

  const ownedKeyId = randomUUID();
  const revokedKeyId = randomUUID();
  const legacyKeyId = randomUUID();
  const otherTenantKeyId = randomUUID();

  beforeAll(async () => {
    setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 7));
    db = getDb();
    source = new DrizzleCliToolSecretSource(db);
    await db
      .insert(tenants)
      .values([
        { id: tenantId, name: `cli-secret-${tenantId}`, status: "active" },
        { id: otherTenantId, name: `cli-secret-other-${otherTenantId}`, status: "active" },
      ])
      .onConflictDoNothing();

    await db.insert(apiKeys).values([
      {
        id: ownedKeyId,
        tenantId,
        keyHash: hashSecret(PLAINTEXT),
        keyEncrypted: encryptCredential(PLAINTEXT),
        label: "recoverable",
        scopes: ["routing:invoke"],
        keyPrefix: "ctk_",
      },
      {
        id: revokedKeyId,
        tenantId,
        keyHash: hashSecret("ctk_revoked_secret"),
        keyEncrypted: encryptCredential("ctk_revoked_secret"),
        label: "revoked",
        scopes: ["routing:invoke"],
        keyPrefix: "ctk_",
        revokedAt: new Date(),
      },
      {
        id: legacyKeyId,
        tenantId,
        // No recoverable copy: this is a key created before `key_encrypted`
        // existed, so there is nothing to hand a CLI tool.
        keyHash: hashSecret("ctk_legacy_secret"),
        keyEncrypted: null,
        label: "legacy",
        scopes: ["routing:invoke"],
        keyPrefix: "ctk_",
      },
      {
        id: otherTenantKeyId,
        tenantId: otherTenantId,
        keyHash: hashSecret("ctk_other_tenant_secret"),
        keyEncrypted: encryptCredential("ctk_other_tenant_secret"),
        label: "other-tenant",
        scopes: ["routing:invoke"],
        keyPrefix: "ctk_",
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(apiKeys).where(inArray(apiKeys.tenantId, [tenantId, otherTenantId]));
    await db.delete(tenants).where(inArray(tenants.id, [tenantId, otherTenantId]));
    setCredentialEncryptionKeyForTesting(undefined);
  });

  test("resolveSecret returns the decrypted secret for the owning tenant", async () => {
    const resolved = await source.resolveSecret(tenantId, ownedKeyId);
    expect(resolved).toEqual({
      id: ownedKeyId,
      label: "recoverable",
      keyPrefix: "ctk_",
      secret: PLAINTEXT,
    });
  });

  test("resolveSecret never resolves another tenant's key", async () => {
    // The tenant boundary is the whole point of the read: a console session
    // must not be able to pull a foreign key's plaintext by guessing its id.
    expect(await source.resolveSecret(tenantId, otherTenantKeyId)).toBeUndefined();
    expect(await source.resolveSecret(otherTenantId, ownedKeyId)).toBeUndefined();
  });

  test("resolveSecret refuses a revoked key", async () => {
    expect(await source.resolveSecret(tenantId, revokedKeyId)).toBeUndefined();
  });

  test("resolveSecret refuses a key with no recoverable copy", async () => {
    // The row exists and is not revoked, but there is nothing to decrypt.
    expect(await source.resolveSecret(tenantId, legacyKeyId)).toBeUndefined();
  });

  test("resolveSecret returns nothing for an unknown key id", async () => {
    expect(await source.resolveSecret(tenantId, randomUUID())).toBeUndefined();
  });

  test("resolveSecretByValue matches the stored hash and returns the secret", async () => {
    const resolved = await source.resolveSecretByValue(tenantId, PLAINTEXT);
    expect(resolved?.id).toBe(ownedKeyId);
    expect(resolved?.secret).toBe(PLAINTEXT);
  });

  test("resolveSecretByValue is tenant-scoped", async () => {
    // The other tenant's plaintext must not resolve under this tenant, even
    // though the hash matches some row somewhere.
    expect(await source.resolveSecretByValue(tenantId, "ctk_other_tenant_secret")).toBeUndefined();
  });

  test("resolveSecretByValue refuses a revoked key", async () => {
    expect(await source.resolveSecretByValue(tenantId, "ctk_revoked_secret")).toBeUndefined();
  });

  test("resolveSecretByValue refuses a key with no recoverable copy", async () => {
    expect(await source.resolveSecretByValue(tenantId, "ctk_legacy_secret")).toBeUndefined();
  });

  test("resolveSecretByValue returns nothing for an unknown secret", async () => {
    expect(await source.resolveSecretByValue(tenantId, "not-a-known-secret")).toBeUndefined();
  });

  test("the resolved secret round-trips to the stored ciphertext", async () => {
    // The stored copy is the source of truth; the reader must not invent or
    // transform it.
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, ownedKeyId)).limit(1);
    const resolved = await source.resolveSecret(tenantId, ownedKeyId);
    expect(resolved?.secret).toBe(PLAINTEXT);
    expect(row?.keyEncrypted).toBeInstanceOf(Buffer);
  });
});
