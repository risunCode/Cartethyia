/**
 * A backup must survive a change of encryption key.
 *
 * These tests exist because of one measured defect: a restore wrote the file's
 * credential bytes into the receiving install verbatim, *after* deleting that
 * install's own working credentials. Every provider in the restored
 * configuration then held a secret sealed under a key that was not in the room,
 * so nothing could authenticate — and the operator could not tell, because the
 * restore reported success. The exported file was not at fault; the import was.
 *
 * The rule these tests hold: the payload carries a secret decrypted, and the
 * restore re-seals it under the key of the install it writes into. A payload
 * that still carries another install's ciphertext is refused rather than
 * written, because a credential nobody can open is worse than an absent one —
 * it looks configured.
 */
import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { getDb } from "../../src/persistence/boot";
import { decryptCredentialToString, setCredentialEncryptionKeyForTesting } from "../../src/security/crypto";
import { BackupService } from "../../src/console/backup/service";
import { compressBackup, exportBackup } from "../../src/console/backup/store";
import { tablesForSection } from "../../src/console/backup/contracts";
import { createRunId, dbDescribe, getTestPool } from "../helpers/database";
import { createWorld } from "../helpers/fixtures";

const SECRET = "sk-portability-secret";

/** A second install's key: 32 random bytes, deliberately not this one. */
const otherKey = randomBytes(32);

/**
 * Drops the exporting tenant's own rows after a payload has been taken.
 *
 * Primary keys are global, not per-tenant, so a source row that still exists
 * collides with the payload's copy of itself the moment that payload lands in
 * another tenant of the *same* database. A real migration does not hit this —
 * the receiving install is a different database holding none of these ids — so
 * the test removes the collision rather than asserting around it.
 */
async function dropSourceRows(tenantId: string): Promise<void> {
  const pool = await getTestPool();
  const client = await pool.connect();
  try {
    await client.query("delete from api_keys where tenant_id = $1", [tenantId]);
    await client.query("delete from provider_accounts where tenant_id = $1", [tenantId]);
  } finally {
    client.release();
  }
}

/**
 * The stored credential of one tenant's provider accounts, read straight from
 * Postgres: the assertion is about what a decrypting install sees, so it reads
 * bytes rather than anything the store shaped.
 */
async function sealedCredentialOf(tenantId: string): Promise<Buffer | null> {
  const pool = await getTestPool();
  const client = await pool.connect();
  try {
    const result = await client.query<{ credential_ciphertext: Buffer | null }>(
      "select credential_ciphertext from provider_accounts where tenant_id = $1",
      [tenantId],
    );
    return result.rows[0]?.credential_ciphertext ?? null;
  } finally {
    client.release();
  }
}

dbDescribe("backup credential portability", () => {
  afterAll(() => {
    // Hand the cached key back to the environment, or every later suite in this
    // process seals its fixtures under the wrong one.
    setCredentialEncryptionKeyForTesting(undefined);
  });

  test("a restore re-seals provider credentials under the importing install's key", async () => {
    const db = getDb();
    const world = await createWorld();
    // Tenant-scoped: an export reads only the rows the exporting tenant owns,
    // and `createWorld`'s own account is a shared (null-tenant) catalog row.
    await world.addAccount({ tenantId: world.tenantId, credential: SECRET, credentialKind: "api_key" });

    // Install A exports.
    const { payload } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    await dropSourceRows(world.tenantId);
    const accounts = (payload as unknown as { sections: { config: { provider_accounts: Array<Record<string, unknown>> } } })
      .sections.config.provider_accounts;
    const exported = accounts.find((row) => row.tenant_id === world.tenantId);
    expect(exported).toBeDefined();
    // The file carries the plaintext under the secret's own name, not the
    // column that seals it: that is what makes it restorable at all.
    expect(exported?.access_token).toBe(SECRET);
    expect(exported?.credential_ciphertext).toBeUndefined();

    // Install B, with a different key, restores into a tenant of its own.
    setCredentialEncryptionKeyForTesting(otherKey);
    const importingTenant = randomUUID();
    const service = new BackupService({ db, verifyPassword: async () => true });
    const result = await service.restore("pw", payload, importingTenant);
    expect(result.warnings).toEqual([]);

    const sealed = await sealedCredentialOf(importingTenant);
    expect(sealed).toBeDefined();
    // The assertion that fails without the fix: install A's bytes would still be
    // here, and install B's key would refuse them.
    expect(decryptCredentialToString(sealed as Buffer)).toBe(SECRET);
  });

  test("ciphertext from another install is refused, not written", async () => {
    const db = getDb();
    const world = await createWorld();
    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: {
        config: {
          // Every real export carries the tenant row; the restore forces its id
          // to the importing tenant and upserts it, which is what makes a
          // foreign key into `tenants` satisfiable at all.
          tenants: [
            {
              id: "00000000-0000-0000-0000-000000000000",
              name: "another install",
              status: "active",
              created_at: { __date: new Date().toISOString() },
            },
          ],
          provider_accounts: [
            {
              id: randomBytes(16).toString("hex"),
              provider_id: world.providerId,
              tenant_id: world.tenantId,
              label: "from-another-install",
              // The shape every export before the fix produced: bytes sealed
              // under the exporting install's key, renamed to nothing and
              // written straight through.
              credential_ciphertext: { __bytes: randomBytes(48).toString("base64") },
              credential_kind: "api_key",
              status: "active",
            },
          ],
        },
      },
    };
    const importingTenant = randomUUID();
    const service = new BackupService({ db, verifyPassword: async () => true });
    const result = await service.restore("pw", payload, importingTenant);

    // The account itself is worth keeping; its unopenable credential is not.
    expect(result.restored["provider_accounts"]).toBe(1);
    expect(result.warnings.map((warning) => warning.column)).toContain("credential_ciphertext");
    expect(await sealedCredentialOf(importingTenant)).toBeNull();
  });

  test("a restore accepts the compressed file the export downloads", async () => {
    const db = getDb();
    const world = await createWorld();
    await world.addAccount({ tenantId: world.tenantId, credential: SECRET, credentialKind: "api_key" });
    const { payload } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    await dropSourceRows(world.tenantId);

    const importingTenant = randomUUID();
    const service = new BackupService({ db, verifyPassword: async () => true });

    // What the dashboard puts on disk: gzip bytes, base64-encoded to travel in a
    // JSON body.
    const gzBase64 = compressBackup(payload).toString("base64");
    const fromEnvelope = await service.restore("pw", gzBase64, importingTenant);
    expect(fromEnvelope.format).toBe("native");
    expect(fromEnvelope.restored["provider_accounts"]).toBe(1);

    // And the same bytes as a file, without the base64 step.
    const gzBytes = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
    const fromBytes = await service.restore("pw", new Uint8Array(gzBytes), importingTenant);
    expect(fromBytes.restored["provider_accounts"]).toBeGreaterThan(0);
  });

  test("a payload's secrets are named for what they are, and still restore", async () => {
    const db = getDb();
    const world = await createWorld();
    const importingTenant = randomUUID();
    // The shape every export writes: the sealed columns named for the secret
    // they hold. The compressed download an operator already has is this same
    // shape, which is why it still restores rather than being dropped as a
    // column the schema never had.
    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: {
        config: {
          tenants: [
            {
              id: "00000000-0000-0000-0000-000000000000",
              name: "old install",
              status: "active",
              created_at: { __date: new Date().toISOString() },
            },
          ],
          provider_accounts: [
            {
              id: randomUUID(),
              provider_id: world.providerId,
              tenant_id: importingTenant,
              label: "legacy",
              access_token: SECRET,
              credential_kind: "api_key",
              status: "active",
            },
          ],
        },
      },
    };
    const service = new BackupService({ db, verifyPassword: async () => true });
    const result = await service.restore("pw", payload, importingTenant);

    // Nothing to report: this is the current format, not an anomaly.
    expect(result.warnings).toEqual([]);
    expect(decryptCredentialToString((await sealedCredentialOf(importingTenant)) as Buffer)).toBe(SECRET);
  });

  test("an export names no column by its ciphertext name", async () => {
    const db = getDb();
    const world = await createWorld();
    await world.addAccount({ tenantId: world.tenantId, credential: SECRET, credentialKind: "api_key" });
    const { payload } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    const config = (payload as unknown as { sections: { config: Record<string, Record<string, unknown>[]> } })
      .sections.config;
    // Every name that describes sealed storage rather than the secret itself.
    // A file that still says `credential_ciphertext` while holding plaintext
    // tells its reader the opposite of the truth.
    const forbidden = ["credential_ciphertext", "refresh_ciphertext", "client_secret_ciphertext", "key_encrypted", "token_encrypted"];
    const present: string[] = [];
    for (const [table, rows] of Object.entries(config)) {
      for (const row of rows) {
        for (const name of Object.keys(row)) {
          if (forbidden.includes(name)) present.push(`${table}.${name}`);
        }
      }
    }
    expect(present).toEqual([]);
  });

  test("an export never carries sign-in accounts", async () => {
    const db = getDb();
    const world = await createWorld();
    const { payload } = await exportBackup(db, tablesForSection("config"), world.tenantId);
    const config = (payload as { sections: { config: Record<string, unknown> } }).sections.config;
    expect(config.console_users).toBeUndefined();
    // The run id exists so a leaked fixture row could be told apart from a
    // catalog row; the payload must not describe either install's users.
    expect(createRunId("unused")).toMatch(/unused-[0-9a-f]{8}/);
  });
});
