import { describe, expect, test } from "bun:test";
import { ApiKeyService } from "../../src/console/services/api-keys";
import type { ApiKeyRepository } from "../../src/console/views";

function serviceWithCreate(create: ApiKeyRepository["create"]): ApiKeyService {
  return new ApiKeyService({ create } as unknown as ApiKeyRepository);
}

const validResult = { key: "generated", record: {} } as never;

describe("console API key validation", () => {
  test("rejects short and wildcard custom keys before persistence", async () => {
    let calls = 0;
    const service = serviceWithCreate(async () => {
      calls += 1;
      return validResult;
    });
    for (const key of ["short", "valid-key*", "bad key", "bad.key"]) {
      const result = await service.create({ name: "test", key });
      expect(result).toMatchObject({ ok: false, status: 400, code: "invalid_request" });
    }
    expect(calls).toBe(0);
  });

  test("preserves generated-key behavior when custom key is omitted", async () => {
    let received: unknown;
    const service = serviceWithCreate(async (input) => {
      received = input;
      return validResult;
    });
    const result = await service.create({ name: "generated" });
    expect(result).toBe(validResult);
    expect(received).toMatchObject({ name: "generated", key: undefined });
  });
});
