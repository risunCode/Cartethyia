import { describe, expect, test } from "bun:test";
import type { AccountCandidate } from "../contracts";
import { CredentialSelector, type CredentialConfigStore } from "./credentials";
import type { TokenRefreshPool } from "./token-refresh";

const candidates: readonly AccountCandidate[] = [
  { id: "account-a", providerId: "openai", credentialKind: "api_key", health: null, enabled: true, quotaAvailable: true, modelLocks: null },
  { id: "account-b", providerId: "openai", credentialKind: "api_key", health: null, enabled: true, quotaAvailable: true, modelLocks: null },
  { id: "account-c", providerId: "openai", credentialKind: "api_key", health: null, enabled: true, quotaAvailable: true, modelLocks: null },
];

describe("credential cache affinity", () => {
  test("keeps one affinity key on the same account across round-robin selections", async () => {
    const config: CredentialConfigStore = {
      getAccount: async (id) => ({ id, providerId: "openai", kind: "api_key", secret: `${id}-secret`, enabled: true, priority: 0 }),
      listAccounts: async () => [],
    };
    const selector = new CredentialSelector(config, {} as TokenRefreshPool);

    const first = await selector.select({ providerId: "openai", candidates, strategy: "round-robin", affinityKey: "api-key-1", stickyLimit: 2 });
    expect(first).not.toBeNull();
    if (first === null) return;
    await selector.release(first.selection.leaseId);

    const second = await selector.select({ providerId: "openai", candidates, strategy: "round-robin", affinityKey: "api-key-1", stickyLimit: 2 });
    expect(second?.account.id).toBe(first.account.id);
    if (second !== null) await selector.release(second.selection.leaseId);
  });
});
