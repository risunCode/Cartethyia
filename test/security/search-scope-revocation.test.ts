/**
 * `search:invoke` must be revocable.
 *
 * The console offers the scope as a toggle, so an operator can uncheck it and
 * save. But `createAccessDecision` used to re-grant it to any key holding
 * `routing:invoke`, so the saved revocation vanished on the next read and no
 * key could ever hold routing without search. These cases pin the revocation.
 */
import { describe, expect, test } from "bun:test";
import { createAccessDecision } from "../../src/security/access-control";

describe("search:invoke revocation", () => {
  test("a key granted only routing:invoke does not gain search:invoke", () => {
    const decision = createAccessDecision({
      id: "key-1",
      tenantId: "tenant-1",
      scopes: ["routing:invoke"],
    });
    expect(decision.scopes).not.toContain("search:invoke");
  });

  test("an explicitly granted search:invoke is kept", () => {
    const decision = createAccessDecision({
      id: "key-1",
      tenantId: "tenant-1",
      scopes: ["routing:invoke", "search:invoke"],
    });
    expect(decision.scopes).toContain("search:invoke");
  });

  test("a legacy key with no scopes still defaults to routing:invoke", () => {
    const decision = createAccessDecision({
      id: "key-1",
      tenantId: "tenant-1",
      scopes: [],
    });
    expect(decision.scopes).toContain("routing:invoke");
  });
});
