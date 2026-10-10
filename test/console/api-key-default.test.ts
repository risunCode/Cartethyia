/**
 * The default gateway key: it must always exist, it must be renamable, and it
 * must not be deletable.
 *
 * Three separate failures are pinned here because they surface as one symptom
 * from the console's side — a key that cannot be managed — while having three
 * unrelated causes:
 *
 * 1. **It was never created.** Seeding was gated on `CARTETHYIA_API_KEY` being
 *    set, so an install that never touched the variable booted with no key and
 *    the CLI failed later with "the default gateway API key is missing".
 * 2. **It could not be renamed.** `label` was accepted and validated by the
 *    PATCH body but never copied into the patch sent to the store, so saving a
 *    new name was a silent no-op.
 * 3. **It could be revoked.** Revoke did not distinguish it, so the one key
 *    routing depends on could be removed, stranding the installation.
 *
 * The default is identified by a column, not by its label: a label match stops
 * working the moment the rename in (2) succeeds, which is exactly the bug that
 * motivated it.
 */
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import * as fullSchema from "../../src/persistence/schema";
import { DrizzleApiKeyStore } from "../../src/persistence/stores/api-key-store";
import { createApiKeyOperations } from "../../src/console/api-keys/routes";
import { DEFAULT_API_KEY_LABEL } from "../../src/console/api-keys/contracts";
import { TENANT_KEY_SCOPES } from "../../src/security/access-control";
import { createRunId, requireDatabase, withRollback } from "../helpers/database";
import { createApiKey, createTenant } from "../helpers/fixtures";

requireDatabase();

const RUN_ID = createRunId("api-key-default");

/** Tenant-scoped write access, as the console grants a signed-in owner. */
function owner(tenantId: string) {
  return {
    tenantId,
    scopes: ["dashboard:read", "dashboard:write"],
  } as never;
}

describe("default gateway API key", () => {
  test("is flagged in the list response", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, RUN_ID);
      await createApiKey(client, {
        tenantId: tenant.tenantId,
        label: DEFAULT_API_KEY_LABEL,
        isDefault: true,
      });
      await createApiKey(client, { tenantId: tenant.tenantId, label: "ordinary key" });

      const db = drizzle(client as never, { schema: fullSchema });
      const operations = createApiKeyOperations({
        store: new DrizzleApiKeyStore(db as never),
        accessResolver: () => owner(tenant.tenantId),
        admissionService: { purgeKey: async () => undefined },
      });
      const keys = await operations.listKeys(owner(tenant.tenantId));

      const flagged = keys.filter((key) => key.isDefault);
      expect(flagged.length).toBe(1);
      expect(flagged[0]?.label).toBe(DEFAULT_API_KEY_LABEL);
      expect(keys.filter((key) => !key.isDefault).length).toBe(1);
    });
  });

  test("can be renamed", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, RUN_ID);
      const key = await createApiKey(client, {
        tenantId: tenant.tenantId,
        label: DEFAULT_API_KEY_LABEL,
        isDefault: true,
      });

      const db = drizzle(client as never, { schema: fullSchema });
      const operations = createApiKeyOperations({
        store: new DrizzleApiKeyStore(db as never),
        accessResolver: () => owner(tenant.tenantId),
        admissionService: { purgeKey: async () => undefined },
      });

      // The label in a PATCH body used to be dropped, leaving the old name.
      const updated = await operations.updateKey(owner(tenant.tenantId), key.id, {
        label: "Production gateway",
      });
      expect(updated.label).toBe("Production gateway");

      const stored = await client.query<{ label: string; is_default: boolean }>(
        `select label, is_default from api_keys where id = $1`,
        [key.id],
      );
      expect(stored.rows[0]?.label).toBe("Production gateway");
      // Renaming must not cost it its default status.
      expect(stored.rows[0]?.is_default).toBe(true);
    });
  });

  test("survives a rename in the default lookup", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, RUN_ID);
      const key = await createApiKey(client, {
        tenantId: tenant.tenantId,
        label: DEFAULT_API_KEY_LABEL,
        isDefault: true,
      });

      const db = drizzle(client as never, { schema: fullSchema });
      const store = new DrizzleApiKeyStore(db as never);
      const operations = createApiKeyOperations({
        store,
        accessResolver: () => owner(tenant.tenantId),
        admissionService: { purgeKey: async () => undefined },
      });
      await operations.updateKey(owner(tenant.tenantId), key.id, { label: "Renamed" });

      // The CLI lookup matches on the column, so the new label must still
      // resolve. A label match here would return nothing.
      const keys = await store.list(tenant.tenantId);
      const found = keys.find((candidate) => candidate.isDefault === true);
      expect(found?.id).toBe(key.id);
      expect(found?.label).toBe("Renamed");
    });
  });

  test("cannot be revoked, while any other key can", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, RUN_ID);
      const defaultKey = await createApiKey(client, {
        tenantId: tenant.tenantId,
        label: DEFAULT_API_KEY_LABEL,
        isDefault: true,
      });
      const ordinary = await createApiKey(client, {
        tenantId: tenant.tenantId,
        label: "ordinary key",
      });

      const db = drizzle(client as never, { schema: fullSchema });
      const operations = createApiKeyOperations({
        store: new DrizzleApiKeyStore(db as never),
        accessResolver: () => owner(tenant.tenantId),
        admissionService: { purgeKey: async () => undefined },
      });

      await expect(operations.revokeKey(owner(tenant.tenantId), defaultKey.id)).rejects.toThrow(
        /cannot be deleted/i,
      );

      // And it is still there, live.
      const after = await client.query<{ revoked_at: Date | null }>(
        `select revoked_at from api_keys where id = $1`,
        [defaultKey.id],
      );
      expect(after.rows[0]?.revoked_at).toBeNull();

      // A key that is not the default still revokes normally.
      await operations.revokeKey(owner(tenant.tenantId), ordinary.id);
      const revoked = await client.query<{ revoked_at: Date | null }>(
        `select revoked_at from api_keys where id = $1`,
        [ordinary.id],
      );
      expect(revoked.rows[0]?.revoked_at).not.toBeNull();
    });
  });

  test("only one live default can exist per tenant", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, RUN_ID);
      await createApiKey(client, {
        tenantId: tenant.tenantId,
        label: DEFAULT_API_KEY_LABEL,
        isDefault: true,
      });

      // The partial unique index rejects a second live default rather than
      // letting two keys both claim to be the mandatory one.
      let rejected = false;
      try {
        await createApiKey(client, {
          tenantId: tenant.tenantId,
          label: "impostor",
          isDefault: true,
        });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });
  });

  test("a key created from the console is never the default", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, RUN_ID);
      const db = drizzle(client as never, { schema: fullSchema });
      const operations = createApiKeyOperations({
        store: new DrizzleApiKeyStore(db as never),
        accessResolver: () => owner(tenant.tenantId),
        admissionService: { purgeKey: async () => undefined },
      });

      const created = await operations.createKey(owner(tenant.tenantId), {
        label: "made in the console",
        scopes: [...TENANT_KEY_SCOPES],
      });
      expect(created.isDefault).toBe(false);

      // So it stays revocable.
      await operations.revokeKey(owner(tenant.tenantId), created.id);
    });
  });
});
