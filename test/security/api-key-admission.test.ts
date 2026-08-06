import { describe, expect, test } from "bun:test";
import type { ApiKeyPublic, ApiKeyRepository } from "../../src/storage";
import { ApiKeyAdmission } from "../../src/traffic/admission";

function key(overrides: Partial<ApiKeyPublic> = {}): ApiKeyPublic {
  return {
    id: "key-1",
    name: "test",
    keyPrefix: "ck_test",
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
    createdAt: new Date(0).toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

function repository(used = 0): ApiKeyRepository {
  return {
    sumOneTimeTokensUsed: () => used,
    consumeOneTimeTokens: () => {},
  } as unknown as ApiKeyRepository;
}

describe("API-key admission", () => {
  test("enforces concurrent request reservations and releases idempotently", () => {
    const admission = new ApiKeyAdmission(repository());
    const lease = admission.acquire(key({ maxConcurrentRequests: 1 }), 1);
    expect(() => admission.acquire(key({ maxConcurrentRequests: 1 }), 1)).toThrow();
    lease.release();
    lease.release();
    expect(() => admission.acquire(key({ maxConcurrentRequests: 1 }), 1)).not.toThrow();
  });

  test("reserves and commits one-time token usage", () => {
    let consumed = 0;
    const store = repository();
    store.consumeOneTimeTokens = (_id: string, tokens: number) => { consumed += tokens; };
    const admission = new ApiKeyAdmission(store);
    const lease = admission.acquire(key({ oneTimeTokenLimit: 5 }), 2);
    lease.commit({ inputTokens: 2, outputTokens: 1 });
    expect(consumed).toBe(3);
    expect(() => admission.acquire(key({ oneTimeTokenLimit: 5 }), 3)).not.toThrow();
  });

  test("enforces RPM before upstream work", () => {
    const admission = new ApiKeyAdmission(repository());
    const limited = key({ rateLimitRpm: 1 });
    const lease = admission.acquire(limited, 1);
    expect(() => admission.acquire(limited, 1)).toThrow();
    lease.release();
  });
});
