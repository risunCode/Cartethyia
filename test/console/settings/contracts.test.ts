import { ConsoleDomainError } from "../../../src/console/shared/errors";
import { describe, expect, test } from "bun:test";
import {
  createRuntimeSettingsOperations,
  type RuntimeSettingsResponse,
  type RuntimeSettingsStore,
  type UpdateRuntimeSettingsRequest,
} from "../../../src/console/settings/contracts";
import { resolveRedisMode } from "../../../src/persistence/readiness";
import type { AccessDecision } from "../../../src/security/access-control";

const access: AccessDecision = {
  id: "key-1",
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "dashboard:write"],
  admissionIdentity: "key-1",
};
const readOnly: AccessDecision = { ...access, scopes: ["dashboard:read"] };
const REMOVED_RUNTIME_SETTING_KEYS = [
  "tokenSaverProfile",
  "ponytailEnabled",
  "cavemanEnabled",
  "contentStrip",
  // Redis mode is a deployment setting, not per-tenant intent: the field was
  // validated here but absent from `runtimeUpdateBody`, so Elysia stripped it
  // and no HTTP caller could ever set it.
  "redisModeDesired",
] as const;

function makeStore(): RuntimeSettingsStore {
  const rows = new Map<string, RuntimeSettingsResponse>();
  return {
    async get(tenantId) {
      return rows.get(tenantId) ?? {
        redisModeActual: resolveRedisMode(),
        tenantConcurrencyLimit: null,
        thinkingNormalizationEnabled: false,
        responsesReasoningSummary: "detailed",
        telemetryPayloads: "bounded",
        privacyMode: "masked",
        updatedAt: new Date(0).toISOString(),
      };
    },
    async update(tenantId, patch) {
      const next = { ...(await this.get(tenantId)), ...patch } as RuntimeSettingsResponse;
      rows.set(tenantId, next);
      return next;
    },
  };
}

describe("runtime settings operations", () => {
  test("returns clean defaults without removed runtime settings", async () => {
    const factory = createRuntimeSettingsOperations({ store: makeStore(), accessResolver: () => access });
    const result = await factory.get(access);
    expect(result.redisModeActual).toBe(resolveRedisMode());
    for (const key of REMOVED_RUNTIME_SETTING_KEYS) {
      expect(key in result).toBe(false);
    }
  });

  test("validates tenant concurrency", async () => {
    const factory = createRuntimeSettingsOperations({ store: makeStore(), accessResolver: () => access });
    await expect(factory.update(access, { tenantConcurrencyLimit: 0 })).rejects.toBeInstanceOf(ConsoleDomainError);
  });

  test("requires dashboard write scope", async () => {
    const factory = createRuntimeSettingsOperations({ store: makeStore(), accessResolver: () => access });
    await expect(factory.update(readOnly, { thinkingNormalizationEnabled: true })).rejects.toMatchObject({
      code: "insufficient_scope",
    });
  });

  test("round-trips active settings", async () => {
    const factory = createRuntimeSettingsOperations({ store: makeStore(), accessResolver: () => access });
    const result = await factory.update(access, {
      thinkingNormalizationEnabled: true,
      responsesReasoningSummary: "concise",
      telemetryPayloads: "none",
    });
    expect(result.thinkingNormalizationEnabled).toBe(true);
    expect(result.responsesReasoningSummary).toBe("concise");
    expect(result.telemetryPayloads).toBe("none");
  });

  test("rejects invalid telemetry payload mode", async () => {
    const factory = createRuntimeSettingsOperations({ store: makeStore(), accessResolver: () => access });
    const bad = { telemetryPayloads: "always" } as unknown as UpdateRuntimeSettingsRequest;
    await expect(factory.update(access, bad)).rejects.toMatchObject({ code: "invalid_request" });
  });
});
