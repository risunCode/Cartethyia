import { afterEach, describe, expect, test, vi } from "vitest";
import { ACCOUNT_IMPORT_CHUNK_SIZE, createAccountsInBatches } from "../../src/lib/account-batch";

describe("queued account imports", () => {
  afterEach(() => vi.restoreAllMocks());

  test("serializes large imports into bounded chunks", async () => {
    let active = 0;
    let maximumActive = 0;
    const requests: Array<{ path: string; count: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const body = JSON.parse(String(init?.body)) as { items: unknown[] };
      requests.push({ path: String(input), count: body.items.length });
      await Promise.resolve();
      active -= 1;
      return new Response(JSON.stringify({ data: { processed: body.items.length, succeeded: body.items.length, failed: 0 } }), { status: 200 });
    }));

    const result = await createAccountsInBatches("provider", Array.from({ length: 10_000 }, (_, index) => ({
      label: `account-${index}`,
      credentialRef: `ref-${index}`,
      enabled: true,
    })));

    expect(result).toEqual({ created: 10_000, skipped: 0 });
    expect(maximumActive).toBe(1);
    expect(requests).toHaveLength(Math.ceil(10_000 / ACCOUNT_IMPORT_CHUNK_SIZE));
    expect(Math.max(...requests.map((request) => request.count))).toBeLessThanOrEqual(ACCOUNT_IMPORT_CHUNK_SIZE);
    expect(requests.every((request) => request.path === "/console/api/v2/admin/providers/provider/accounts/batch")).toBe(true);
  });

  test("retains bounded partial failure details without accepting secret fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { items: Array<Record<string, unknown>> };
      expect(body.items[0]).toEqual({ credentialRef: "opaque/ref", label: "account", enabled: true });
      expect(body.items[0]).not.toHaveProperty("token");
      return new Response(JSON.stringify({
        data: { processed: 1, succeeded: 0, failed: 1, errors: ["forbidden scope", "provider response token"] },
      }), { status: 200 });
    }));
    await expect(createAccountsInBatches("provider", [{ label: "account", credentialRef: "opaque/ref" }])).resolves.toEqual({
      created: 0,
      skipped: 1,
      errors: ["forbidden scope"],
    });
  });
});
