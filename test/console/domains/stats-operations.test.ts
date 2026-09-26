import { describe, expect, test } from "bun:test";
import {
  createObservabilityOperations,
  isSupportedUsagePeriod,
  USAGE_DIMENSIONS,
  type ObservabilityStore,
} from "../../../src/console/domains/stats/contracts";
import { createAccessDecision } from "../../../src/security/access-control";

/**
 * The observability operations are the console's tenant boundary for stats:
 * every entry point narrows the caller to a tenant and a scope *before* the
 * store is touched, validates its own query parameters, and redacts telemetry
 * before returning. Those are the decisions worth pinning, so the store is a
 * recording stub — what is under test is the gate in front of it, not SQL.
 */

interface Recorded {
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }>;
}

function stubStore(recorded: Recorded, overrides: Partial<ObservabilityStore> = {}): ObservabilityStore {
  const record =
    (method: string, result: unknown) =>
    async (...args: unknown[]): Promise<never> => {
      recorded.calls.push({ method, args });
      return result as never;
    };
  return {
    health: record("health", { status: "ok" }),
    usage: record("usage", { period: "7d" }),
    listEvents: record("listEvents", { entries: [] }),
    getEvent: record("getEvent", { id: "evt" }),
    usageSummary: record("usageSummary", {}),
    usageChart: record("usageChart", {}),
    usageBy: record("usageBy", {}),
    usageCache: record("usageCache", {}),
    usageRequests: record("usageRequests", {}),
    usageRequestDetail: record("usageRequestDetail", { id: "req" }),
    ...overrides,
  };
}

function operations(recorded: Recorded, overrides: Partial<ObservabilityStore> = {}) {
  return createObservabilityOperations({
    store: stubStore(recorded, overrides),
    accessResolver: () => undefined,
  });
}

const tenantAccess = createAccessDecision({
  id: "user-1",
  tenantId: "tenant-1",
  scopes: ["dashboard:read"],
});

describe("isSupportedUsagePeriod", () => {
  test("accepts the declared presets and any hour/day token", () => {
    for (const period of ["1h", "24h", "7d", "30d", "all"]) {
      expect(isSupportedUsagePeriod(period)).toBe(true);
    }
    // The predicate is deliberately wider than the preset list: it accepts any
    // `\d+[hd]` token, so a custom window is a valid request even though the
    // dashboard only offers presets.
    expect(isSupportedUsagePeriod("6h")).toBe(true);
    expect(isSupportedUsagePeriod("12h")).toBe(true);
  });

  test("rejects a token that is not a window", () => {
    expect(isSupportedUsagePeriod("")).toBe(false);
    expect(isSupportedUsagePeriod("7D")).toBe(false);
    expect(isSupportedUsagePeriod("week")).toBe(false);
    expect(isSupportedUsagePeriod("d")).toBe(false);
    expect(isSupportedUsagePeriod("7")).toBe(false);
  });
});

describe("observability operations tenant boundary", () => {
  test("an unauthenticated caller is rejected before the store is read", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded);
    await expect(ops.getSystemHealth(undefined)).rejects.toMatchObject({ code: "unauthorized" });
    expect(recorded.calls).toHaveLength(0);
  });

  test("a caller without dashboard:read is rejected before the store is read", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded);
    const routingOnly = createAccessDecision({
      id: "key-1",
      tenantId: "tenant-1",
      scopes: ["routing:invoke"],
    });
    await expect(ops.getSystemHealth(routingOnly)).rejects.toMatchObject({
      code: "insufficient_scope",
      status: 403,
    });
    expect(recorded.calls).toHaveLength(0);
  });

  test("a caller with no tenant is rejected — stats are never global", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded);
    const platformWide = createAccessDecision({
      id: "user-2",
      tenantId: null,
      scopes: ["dashboard:read", "platform:admin"],
    });
    await expect(ops.getSystemHealth(platformWide)).rejects.toMatchObject({
      code: "tenant_required",
    });
    expect(recorded.calls).toHaveLength(0);
  });

  test("an authorized caller is scoped to its own tenant", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded);
    await ops.getSystemHealth(tenantAccess);
    expect(recorded.calls[0]?.method).toBe("health");
    expect(recorded.calls[0]?.args[0]).toBe("tenant-1");
  });
});

describe("observability query validation", () => {
  test("rejects an unsupported usage period", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded);
    await expect(ops.getTenantUsage(tenantAccess, "bogus")).rejects.toMatchObject({
      code: "invalid_period",
      status: 400,
    });
    expect(recorded.calls).toHaveLength(0);
  });

  test("rejects an unsupported usage dimension", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded);
    await expect(
      ops.getUsageBy(tenantAccess, "not-a-dimension" as never, "24h"),
    ).rejects.toMatchObject({ code: "invalid_dimension", status: 400 });
    expect(recorded.calls).toHaveLength(0);
  });

  test("accepts every declared usage dimension", async () => {
    for (const dimension of USAGE_DIMENSIONS) {
      const recorded: Recorded = { calls: [] };
      const ops = operations(recorded);
      await ops.getUsageBy(tenantAccess, dimension, "24h");
      expect(recorded.calls[0]?.args[1]).toBe(dimension);
    }
  });

  test("clamps the event limit to the declared range", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded);
    await ops.listEvents(tenantAccess, "1000");
    // `listEvents` caps at 100.
    expect(recorded.calls[0]?.args[1]).toBe(100);
    await ops.listEvents(tenantAccess, "0");
    expect(recorded.calls[1]?.args[1]).toBe(1);
    await ops.listEvents(tenantAccess, undefined);
    expect(recorded.calls[2]?.args[1]).toBe(50);
  });

  test("rejects a non-numeric event limit", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded);
    await expect(ops.listEvents(tenantAccess, "abc")).rejects.toMatchObject({
      code: "invalid_limit",
    });
  });

  test("validates the HTTP status filter range", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded);
    await expect(ops.listUsageRequests(tenantAccess, "24h", undefined, "99")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(ops.listUsageRequests(tenantAccess, "24h", undefined, "600")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      ops.listUsageRequests(tenantAccess, "24h", undefined, "2.5"),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await ops.listUsageRequests(tenantAccess, "24h", undefined, "404");
    expect(recorded.calls[0]?.args[3]).toBe(404);
  });

  test("omits the status filter entirely when not supplied", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded);
    await ops.listUsageRequests(tenantAccess, "24h");
    expect(recorded.calls[0]?.args[3]).toBeUndefined();
  });
});

describe("observability not-found handling", () => {
  test("a missing event is a 404", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded, { getEvent: async () => undefined });
    await expect(ops.getEventDetail(tenantAccess, "gone")).rejects.toMatchObject({
      code: "event_not_found",
      status: 404,
    });
  });

  test("a missing request detail is a 404", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded, { usageRequestDetail: async () => undefined });
    await expect(ops.getUsageRequestDetail(tenantAccess, "gone")).rejects.toMatchObject({
      code: "event_not_found",
      status: 404,
    });
  });

  test("a request detail without payloads reports an explicit null", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded, {
      usageRequestDetail: async () => ({ id: "req-1" }) as never,
    });
    const detail = await ops.getUsageRequestDetail(tenantAccess, "req-1");
    expect(detail.payloads).toBeNull();
  });
});

describe("observability redaction", () => {
  test("telemetry values are redacted before they leave the operation", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded, {
      listEvents: async () =>
        ({
          entries: [
            {
              id: "e1",
              authorization: "Bearer super-secret",
              apiKey: "sk-live-123",
              clientIp: "203.0.113.9",
            },
          ],
        }) as never,
    });
    const page = await ops.listEvents(tenantAccess, "10");
    const entry = page.entries[0] as unknown as Record<string, unknown>;
    // The redactor is the same one the log pipeline uses: secrets are replaced,
    // so a stats response can never be a credential exfiltration path.
    expect(entry["authorization"]).not.toBe("Bearer super-secret");
    expect(entry["apiKey"]).not.toBe("sk-live-123");
  });

  test("a page with a next cursor carries it through", async () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded, {
      listEvents: async () => ({ entries: [], nextCursor: "cursor-2" }) as never,
    });
    const page = await ops.listEvents(tenantAccess, "10");
    expect(page.nextCursor).toBe("cursor-2");
  });
});

describe("requirePeriod and requireTenant", () => {
  test("requirePeriod returns a valid period and rejects an invalid one", () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded);
    expect(ops.requirePeriod("7d")).toBe("7d");
    expect(() => ops.requirePeriod("nope")).toThrow(/Unsupported usage period/);
  });

  test("requireTenant returns the tenant id or throws", () => {
    const recorded: Recorded = { calls: [] };
    const ops = operations(recorded);
    expect(ops.requireTenant(tenantAccess)).toBe("tenant-1");
    expect(() => ops.requireTenant(undefined)).toThrow();
  });
});
