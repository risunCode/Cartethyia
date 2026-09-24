import { describe, expect, test } from "bun:test";
import {
  TENANT_KEY_SCOPES,
  createAccessDecision,
  isValidTenantKeyScope,
  type AccessScope,
} from "../../src/security/access-control";

describe("AccessScope type", () => {
  test("all four scopes exist and are distinct", () => {
    const scopes: AccessScope[] = [
      "routing:invoke",
      "dashboard:read",
      "dashboard:write",
      "platform:admin",
    ];
    expect(scopes).toHaveLength(4);
    expect(new Set(scopes)).toHaveLength(4);
  });
});

describe("AccessDecision immutability", () => {
  test("AccessDecision is deeply frozen", () => {
    const decision = createAccessDecision({
      id: "key123",
      tenantId: "tenant-a",
      scopes: ["routing:invoke"],
    });

    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.scopes)).toBe(true);

    // Cannot mutate
    expect(() => {
      (decision as unknown as Record<string, unknown>).id = "modified";
    }).toThrow();
  });

  test("scopes array is copied and frozen", () => {
    const scopes: AccessScope[] = ["routing:invoke", "dashboard:read"];
    const decision = createAccessDecision({
      id: "key123",
      tenantId: "tenant-a",
      scopes,
    });

    // Modify original array
    scopes.push("dashboard:write");

    // Decision is unaffected
    expect(decision.scopes).toEqual(["routing:invoke", "dashboard:read"]);
  });

  test("admissionIdentity defaults to id", () => {
    const decision = createAccessDecision({
      id: "key123",
      tenantId: "tenant-a",
      scopes: ["routing:invoke"],
    });

    expect(decision.admissionIdentity).toBe("key123");
  });

  test("admissionIdentity is preserved when provided", () => {
    const decision = createAccessDecision({
      id: "key123",
      tenantId: "tenant-a",
      scopes: ["routing:invoke"],
      admissionIdentity: "custom-identity",
    });

    expect(decision.admissionIdentity).toBe("custom-identity");
  });
});

describe("Default tenant key scopes", () => {
  test("empty scopes default to routing:invoke for tenant keys", () => {
    const decision = createAccessDecision({
      id: "key123",
      tenantId: "tenant-a",
      scopes: [],
    });

    expect(decision.scopes).toEqual(["routing:invoke"]);
  });

  test("empty scopes remain empty for principals without a tenant", () => {
    const decision = createAccessDecision({
      id: "sa-key",
      tenantId: null,
      scopes: [],
    });

    expect(decision.scopes).toEqual([]);
  });

  test("explicit scopes are preserved", () => {
    const decision = createAccessDecision({
      id: "key123",
      tenantId: "tenant-a",
      scopes: ["routing:invoke", "dashboard:read"],
    });

    expect(decision.scopes).toEqual(["routing:invoke", "dashboard:read"]);
  });
});

describe("isValidTenantKeyScope", () => {
  test("valid tenant scopes: routing:invoke, dashboard:read, dashboard:write", () => {
    expect(isValidTenantKeyScope("routing:invoke")).toBe(true);
    expect(isValidTenantKeyScope("dashboard:read")).toBe(true);
    expect(isValidTenantKeyScope("dashboard:write")).toBe(true);
  });

  test("invalid tenant scope: platform:admin — no escalation path from a tenant key", () => {
    expect(isValidTenantKeyScope("platform:admin")).toBe(false);
  });

  test("TENANT_KEY_SCOPES is the complete assignable set, and the predicate accepts all of it", () => {
    // The dashboard's API-key editor renders this list directly. It used to
    // hardcode only the four routing/dashboard scopes, so a `providers:write`
    // key could be minted through the API but not through the UI — the catalog
    // scopes existed and worked, they were simply unofferable.
    expect([...TENANT_KEY_SCOPES].sort()).toEqual([
      "dashboard:read",
      "dashboard:write",
      "models:read",
      "models:write",
      "providers:read",
      "providers:write",
      "routing:cli_mapping",
      "routing:invoke",
    ]);
    for (const scope of TENANT_KEY_SCOPES) {
      expect({ scope, valid: isValidTenantKeyScope(scope) }).toEqual({ scope, valid: true });
    }
    // The two must not drift: everything the editor offers is assignable, and
    // nothing assignable is missing from it.
    expect(TENANT_KEY_SCOPES).not.toContain("platform:admin");
  });
});
