import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { ApiKeyRecord } from "../../src/persistence/api-key-store";
import { getDb, type CartethyiaDatabase } from "../../src/persistence/postgres";
import { telemetryEvents, telemetryUsageTotals, tenants } from "../../src/persistence/schema";
import { DrizzleTelemetryStore } from "../../src/persistence/telemetry-store";
import { createShareUsagePort } from "../../src/console/share/share-usage";
import { gatewayErrorSql, isGatewayError } from "../../src/observability/telemetry-status";
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

  /**
   * The rollup is the one error count that cannot be corrected later: the raw
   * row it came from is pruned, so whatever was counted here stays counted
   * forever. It must therefore apply the same rule as the read-side counts —
   * a 404 probe, a 499 abort and a 503 capacity refusal are not gateway
   * errors, while a 500 is.
   */
  test("the durable rollup excludes client and capacity outcomes from errors", async () => {
    const rollupTenantId = randomUUID();
    const rollupAccountId = randomUUID();
    await db.insert(tenants).values({
      id: rollupTenantId,
      name: `telemetry-totals-rollup-${rollupTenantId}`,
      status: "active",
    });
    try {
      const row = (status: "failed" | "completed" | "cancelled", httpStatus: number) => ({
        tenantId: rollupTenantId,
        requestId: randomUUID(),
        sourceSurface: "chat" as const,
        requestedModel: "openai/gpt-5",
        accountId: rollupAccountId,
        stream: false,
        status,
        httpStatus,
        inputTokens: 1,
        outputTokens: 1,
      });
      await store.insertEvents([
        row("failed", 500), // gateway defect -> counted
        row("failed", 503), // capacity refusal -> not counted
        row("failed", 404), // probe -> not counted
        row("cancelled", 499), // client abort -> not counted
      ]);

      const [totals] = await db
        .select()
        .from(telemetryUsageTotals)
        .where(eq(telemetryUsageTotals.tenantId, rollupTenantId));
      // All four requests are counted as traffic; only the 500 is an error.
      expect(totals).toMatchObject({ requests: 4, errors: 1 });
    } finally {
      await db.delete(tenants).where(eq(tenants.id, rollupTenantId));
    }
  });

  /**
   * The SQL predicate (`gatewayErrorSql`) and the row predicate
   * (`isGatewayError`) are two encodings of one rule. The SQL form feeds this
   * durable rollup; the row form feeds the read-side counts. A rollup entry
   * cannot be corrected after its raw row is pruned, so a disagreement is
   * permanent. This runs the real SQL against real Postgres and compares the
   * two verdicts row by row — the check the JS-only test can only restate.
   *
   * The NULL-status row is the case that used to diverge: the row predicate
   * counted an unknown status, while `status in ('failed','truncated')` is NULL
   * for it, so the rollup and the read-side counts disagreed.
   */
  test("the SQL predicate and the row predicate agree on every seeded combination", async () => {
    const agreeTenantId = randomUUID();
    await db.insert(tenants).values({
      id: agreeTenantId,
      name: `telemetry-totals-agree-${agreeTenantId}`,
      status: "active",
    });
    try {
      const combos: Array<{ status: "failed" | "completed" | "cancelled" | "truncated" | null; httpStatus: number | null }> = [
        // Gateway defects — the only rows that may be counted.
        { status: "failed", httpStatus: 500 },
        { status: "truncated", httpStatus: 502 },
        { status: "failed", httpStatus: 504 },
        // Client outcomes: every 4xx, including the two an enumerated list
        // missed (401 from a bogus key, 429 from the caller's own quota).
        { status: "failed", httpStatus: 400 },
        { status: "failed", httpStatus: 401 },
        { status: "failed", httpStatus: 403 },
        { status: "failed", httpStatus: 404 },
        { status: "failed", httpStatus: 413 },
        { status: "failed", httpStatus: 429 },
        { status: "cancelled", httpStatus: 499 },
        // Capacity — 5xx, but not a defect.
        { status: "failed", httpStatus: 503 },
        { status: "truncated", httpStatus: 503 },
        // Historical rows with no wire status: counted from the lifecycle.
        { status: "failed", httpStatus: null },
        { status: "truncated", httpStatus: null },
        // Non-errors.
        { status: "completed", httpStatus: 200 },
        // A row whose lifecycle status is outside the enum.
        { status: null, httpStatus: 500 },
        { status: null, httpStatus: null },
      ];
      // Inserted through the real writer, so the durable rollup is produced by
      // the same code path production uses rather than by a second hand-rolled
      // statement that could itself be wrong. `accountId` is what makes the
      // rollup write a row at all.
      const agreeAccountId = randomUUID();
      await store.insertEvents(
        combos.map((combo) => ({
          tenantId: agreeTenantId,
          requestId: randomUUID(),
          sourceSurface: "chat" as const,
          requestedModel: "openai/gpt-5",
          accountId: agreeAccountId,
          stream: false,
          status: combo.status,
          httpStatus: combo.httpStatus,
        })),
      );

      // What the SQL predicate says, evaluated by Postgres.
      const [sqlCount] = await db
        .select({ n: sql<number>`count(*)` })
        .from(telemetryEvents)
        .where(
          and(
            eq(telemetryEvents.tenantId, agreeTenantId),
            gatewayErrorSql(telemetryEvents.status, telemetryEvents.httpStatus),
          ),
        );

      // What the row predicate says about the very same rows.
      const rows = await db
        .select({ status: telemetryEvents.status, httpStatus: telemetryEvents.httpStatus })
        .from(telemetryEvents)
        .where(eq(telemetryEvents.tenantId, agreeTenantId));
      const rowCount = rows.filter((row) => isGatewayError(row.status, row.httpStatus)).length;

      expect(Number(sqlCount?.n ?? 0)).toBe(rowCount);
      // And the rollup's own count must equal both, since it is written from
      // the row predicate.
      const [rollup] = await db
        .select()
        .from(telemetryUsageTotals)
        .where(eq(telemetryUsageTotals.tenantId, agreeTenantId));
      expect(rollup?.errors).toBe(rowCount);
    } finally {
      await db.delete(tenants).where(eq(tenants.id, agreeTenantId));
    }
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
