import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ApiKeyRecord } from "../../src/persistence/api-key-store";
import { getDb, type CartethyiaDatabase } from "../../src/persistence/postgres";
import { telemetryEvents, telemetryUsageTotals, tenants } from "../../src/persistence/schema";
import { DrizzleTelemetryStore } from "../../src/persistence/telemetry-store";
import { createShareUsagePort } from "../../src/console/share/share-usage";
import { dbDescribe } from "../helpers/db-gate";

dbDescribe("telemetry lifetime aggregates", () => {
  const tenantId = randomUUID();
  const accountId = randomUUID();
  const apiKeyId = randomUUID();
  let db: CartethyiaDatabase;
  let store: DrizzleTelemetryStore;

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleTelemetryStore(db);
    await db.insert(tenants).values({
      id: tenantId,
      name: `telemetry-totals-${tenantId}`,
      status: "active",
    });
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("retains account and API-key totals after raw telemetry is removed", async () => {
    await store.insertEvents([
      {
        tenantId,
        requestId: randomUUID(),
        sourceSurface: "chat",
        requestedModel: "openai/gpt-5",
        accountId,
        apiKeyId,
        stream: false,
        status: "completed",
        inputTokens: 50,
        outputTokens: 12,
        clientIp: "198.51.100.7",
      },
      {
        tenantId,
        requestId: randomUUID(),
        sourceSurface: "chat",
        requestedModel: "openai/gpt-5",
        accountId,
        apiKeyId,
        stream: false,
        status: "failed",
        inputTokens: 7,
        outputTokens: 1,
        clientIp: "198.51.100.9",
      },
    ]);

    const firstRead = await db
      .select()
      .from(telemetryUsageTotals)
      .where(eq(telemetryUsageTotals.tenantId, tenantId));
    expect(firstRead).toHaveLength(2);
    for (const identityType of ["account", "api_key"] as const) {
      expect(firstRead.find((row) => row.identityType === identityType)).toMatchObject({
        identityType,
        requests: 2,
        errors: 1,
        inputTokens: 57,
        outputTokens: 13,
      });
    }

    const child: ApiKeyRecord = {
      id: apiKeyId,
      tenantId,
      keyHash: "stored-hash",
      keyMode: "share",
      parentKeyId: randomUUID(),
      issuedClientIp: "198.51.100.11",
      issuedClientIpKey: "v4:3325256715",
      label: "shared child",
      scopes: ["routing:invoke"],
      keyPrefix: "rk_",
      createdAt: new Date(),
      tokensConsumed: 0,
    };
    const activity = createShareUsagePort(db);
    const [summary] = await activity.getSharedKeySummaries(tenantId, [child]);
    expect(summary?.allTime).toMatchObject({
      requests: 2,
      errors: 1,
      inputTokens: 57,
      outputTokens: 13,
      totalTokens: 70,
    });
    expect(summary?.issuedClientIp).toBe("198.51.100.xxx");
    const detail = await activity.getSharedKeyDetail(tenantId, apiKeyId);
    expect(detail.models[0]).toMatchObject({
      modelId: "openai/gpt-5",
      retainedRequests: 2,
      retainedErrors: 1,
      retainedTokens: 70,
    });
    expect(detail.requests[0]?.clientIp).toMatch(/^198\.51\.100\.xxx$/);

    await db.delete(telemetryEvents).where(eq(telemetryEvents.tenantId, tenantId));
    const retained = await db
      .select()
      .from(telemetryUsageTotals)
      .where(eq(telemetryUsageTotals.tenantId, tenantId));
    expect(retained).toHaveLength(2);
    expect(retained.every((row) => row.requests === 2 && row.errors === 1)).toBe(true);
  });
});
