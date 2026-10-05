import { describe, expect, test } from "bun:test";
import { createAuthorizationSnapshot, type ResolvedApiKey } from "../../src/security/api-key-auth";
import type { ApiKeyAdmissionService } from "../../src/security/admission/service";
import { ProxyRequestPreparer } from "../../src/transport/request/preparer";
import { InMemoryRouteSnapshotService, type RouteSnapshot } from "../../src/transport/routing/route-model";
import { RoutingEngine } from "../../src/transport/routing/router";

function nativePreparer(snapshot: RouteSnapshot): ProxyRequestPreparer {
  return new ProxyRequestPreparer({
    snapshotService: new InMemoryRouteSnapshotService(async () => snapshot),
    routingEngine: new RoutingEngine(),
    admissionService: {} as ApiKeyAdmissionService,
  });
}

function authorization(
  modelList: readonly string[],
  mode: "whitelist" | "blacklist" = "whitelist",
): ResolvedApiKey {
  const snapshot = createAuthorizationSnapshot({
    api_key_id: "key-1",
    tenant_id: "tenant-1",
    model_access_mode: mode,
    model_list: modelList,
    scopes: ["routing:invoke"],
  });
  return {
    id: "key-1",
    tenantId: "tenant-1",
    scopes: ["routing:invoke"],
    snapshot,
  };
}

function systemoneSnapshot(): RouteSnapshot {
  return {
    revision: 1,
    candidates: [
      {
        provider_id: "provider-a",
        model_id: "secret-model",
        service_kind: "systemone",
        wire_family: "chat",
        endpoint: "/v1/systemone",
        capability_profile: {},
        provider_account_id: "account-a",
        tenant_id: null,
      },
    ],
    aliases: {},
    combos: {},
    created_at: Date.now(),
  };
}

describe("native model admission", () => {
  test("rejects a native model that is outside the key whitelist", async () => {
    const preparer = nativePreparer(systemoneSnapshot());

    await expect(
      preparer.prepareNativeService({
        model: "secret-model",
        serviceKind: "systemone",
        authorization: authorization(["allowed-model"]),
      }),
    ).rejects.toMatchObject({ code: "model_not_found", status: 404 });
  });

  test("does not let a combo bypass a blacklisted concrete member", async () => {
    const snapshot: RouteSnapshot = {
      ...systemoneSnapshot(),
      combos: {
        "tenant-1": {
          bundle: {
            members: ["provider-a/secret-model"],
            strategy: "fallback",
          },
        },
      },
    };
    const preparer = nativePreparer(snapshot);

    await expect(
      preparer.prepareNativeService({
        model: "bundle",
        serviceKind: "systemone",
        authorization: authorization(["secret-model"], "blacklist"),
      }),
    ).rejects.toMatchObject({ code: "model_not_found", status: 404 });
  });
});
