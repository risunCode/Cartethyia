import { describe, expect, test } from "bun:test";
import type { ApiKeyPublic, ApiKeyRepository } from "../storage";
import { ApiKeyAdmission, estimateRequestTokens } from "./admission";

function admissionApiKey(overrides: Partial<ApiKeyPublic> = {}): ApiKeyPublic {
  return {
    id: "key-1",
    name: "test-key",
    keyPrefix: "sk-test",
    active: true,
    rateLimitRpm: null,
    dailyTokenLimit: null,
    monthlyTokenLimit: null,
    oneTimeTokenLimit: null,
    oneTimeTokensUsed: 0,
    maxConcurrentRequests: null,
    providerAllowlist: null,
    modelAllowlist: null,
    modelDenylist: null,
    lastUsedAt: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function admissionRepository(consumed: { value: number }): ApiKeyRepository {
  return {
    list: () => [],
    getById: () => null,
    getBySecret: () => null,
    credential: () => null,
    create: () => admissionApiKey(),
    update: () => null,
    revoke: () => false,
    delete: () => false,
    touch: () => {},
    flushTouches: () => {},
    sumOneTimeTokensUsed: () => 0,
    consumeOneTimeTokens: (_id, tokens) => { consumed.value += tokens; },
  };
}

function thrownAdmissionError(action: () => unknown): { kind: string; statusCode: number } {
  try {
    action();
  } catch (error) {
    return error as { kind: string; statusCode: number };
  }
  throw new Error("Expected admission to reject");
}

describe("API key admission", () => {
  test("enforces concurrency and makes lease settlement idempotent", () => {
    const admission = new ApiKeyAdmission(admissionRepository({ value: 0 }));
    const key = admissionApiKey({ maxConcurrentRequests: 1 });
    const lease = admission.acquire(key, 10);

    expect(thrownAdmissionError(() => admission.acquire(key, 1))).toMatchObject({ kind: "concurrency_exceeded", statusCode: 429 });
    lease.release();
    lease.release();
    expect(() => admission.acquire(key, 1)).not.toThrow();
  });

  test("reserves estimated tokens, then reconciles actual usage", () => {
    const consumed = { value: 0 };
    const admission = new ApiKeyAdmission(admissionRepository(consumed));
    const key = admissionApiKey({ dailyTokenLimit: 10, oneTimeTokenLimit: 20 });
    const lease = admission.acquire(key, 6);

    expect(thrownAdmissionError(() => admission.acquire(key, 5))).toMatchObject({ kind: "quota_exceeded", statusCode: 429 });
    lease.commit({ inputTokens: 2, outputTokens: 2 });

    expect(() => admission.acquire(key, 6)).not.toThrow();
    expect(consumed.value).toBe(4);
  });

  test("uses bounded token estimates for empty and oversized bodies", () => {
    expect(estimateRequestTokens({})).toBeGreaterThanOrEqual(1);
    expect(estimateRequestTokens({ text: "x".repeat(50_000_000) })).toBeLessThanOrEqual(10_000_000);
  });
});
