import { describe, expect, test } from "bun:test";
import { createQuotaRefreshWorker } from "./workers";

describe("quota refresh worker detached logging", () => {
  test("logs a sanitized warning when account labeling rejects", async () => {
    const messages: string[] = [];
    const worker = createQuotaRefreshWorker({
      credentialStore: {
        listAccounts: async () => [{ id: "account-1", providerId: "openai", kind: "api_key", secret: null, enabled: true, priority: 1 }],
      },
      quotaState: { get: async () => undefined },
      refreshQuota: async () => true,
      labelAccount: async () => { throw new Error("secret=super-secret"); },
      logger: {
        web: () => undefined,
        request: () => undefined,
        system: (_level: string, _scope: string, message: string) => { messages.push(message); },
      } } as unknown as Parameters<typeof createQuotaRefreshWorker>[0]);

    await worker.sweep();
    await Promise.resolve();
    await Promise.resolve();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("credential=[redacted]");
    expect(messages[0]).not.toContain("super-secret");
  });
});
