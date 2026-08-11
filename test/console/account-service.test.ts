import { describe, expect, test } from "bun:test";
import { AccountService } from "../../src/console/services/accounts";
import type { AccountRepository, RouteTransitionStore } from "../../src/console/views";

function makeService(created: string[]): AccountService {
  const repository = {
    create: async (input: { readonly name: string }) => {
      const id = `account-${created.length + 1}`;
      created.push(input.name);
      return { id, credentialHint: `${input.name.slice(0, 3)}…` };
    },
  } as unknown as AccountRepository;
  return new AccountService(repository, {} as RouteTransitionStore);
}

describe("account batch creation", () => {
  test("accepts a large batch without issuing a request-sized failure", async () => {
    const created: string[] = [];
    const service = makeService(created);
    const result = await service.createBatch("provider", {
      items: Array.from({ length: 1_000 }, (_, index) => ({
        name: `key-${index + 1}`,
        credentialKind: "api_key",
        credential: `secret-${index + 1}`,
      })),
    });

    expect(result).toEqual({ created: 1_000, skipped: 0 });
    expect(created).toHaveLength(1_000);
  });

  test("rejects oversized chunks so the dashboard can continue with the next queue chunk", async () => {
    const service = makeService([]);
    const result = await service.createBatch("provider", { items: Array.from({ length: 2_001 }, () => ({ name: "key", credential: "secret" })) });

    expect(result).toMatchObject({ ok: false, status: 413 });
  });
});
