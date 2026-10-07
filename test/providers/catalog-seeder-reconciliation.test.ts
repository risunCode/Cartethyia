/**
 * Removing a provider from the bundled catalog must not leave its rows in the
 * model list. The boot path retires an unowned `providers` row whose id the
 * bundle no longer declares, and the model row's foreign key cascades, so the
 * builtin model row goes with it. A tenant-owned row is an operator's BYOK
 * provider and must survive: the console can still delete that one itself.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { models, providers, tenants } from "../../src/persistence/schema";
import { retireUnbundledProviders } from "../../src/providers/operations/provider-catalog-service";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

test("boot retirement drops a removed provider and cascades its model rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-retire-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const db = buildSqliteHandle(sqlite).db;

    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Operator", status: "active" });
    await db.insert(providers).values([
      // Unowned and absent from the bundle: the shape a removed builtin leaves.
      { id: "removed-builtin" },
      // Tenant-owned: the operator added it and can still delete it.
      { id: "operator-byok", tenantId },
    ]);
    await db.insert(models).values([
      {
        providerId: "removed-builtin",
        modelId: "removed-model",
        wireFamily: "chat",
        endpointPath: "/v1/chat/completions",
        source: "builtin",
      },
      {
        providerId: "operator-byok",
        modelId: "byok-model",
        wireFamily: "chat",
        endpointPath: "/v1/chat/completions",
        source: "custom",
      },
    ]);

    const retired = await retireUnbundledProviders(db);

    // Every bundled provider is absent from this database, so only the one
    // unowned orphan qualifies.
    expect(retired).toBe(1);
    const providerRows = await db
      .select({ id: providers.id })
      .from(providers)
      .orderBy(providers.id);
    expect(providerRows.map((row) => row.id)).toEqual(["operator-byok"]);
    const modelRows = await db
      .select({ providerId: models.providerId, modelId: models.modelId })
      .from(models);
    expect(modelRows).toEqual([{ providerId: "operator-byok", modelId: "byok-model" }]);
  } finally {
    sqlite.close();
    removeDir(dir);
  }
});
