/**
 * Kiro browser login through the real console route: the AWS Builder ID option
 * end to end.
 *
 * The provider-level suite pins the authorize URL and exchange bodies. This
 * suite pins the wiring an operator actually hits: `beginAuthorize` on the
 * console route must run the client's authorize pre-step, file the client
 * registration as provider-private state, and hand the code exchange the
 * context it needs — while the credential lands through the same
 * `persistAccount` the device flow and the social flow already use.
 *
 * The registry, flow store and account store are the real types; only the
 * network (a fetch double) and the loopback bind (an injected `serve`) are
 * replaced, because the assertion is about this gateway's composition, not
 * about AWS or a real socket.
 */
import { describe, expect, test } from "bun:test";
import { createOAuthLoginOperations, completeLogin } from "../../src/console/providers/oauth/routes";
import { OAuthCallbackListener } from "../../src/console/providers/oauth/callback-listener";
import { OAuthFlowStore } from "../../src/providers/authentication/oauth-flow-store";
import type { RedisClient } from "../../src/persistence/redis";
import { KiroOAuthClient } from "../../src/providers/integrations/kiro/kiro-oauth";
import type { ProviderRegistry } from "../../src/providers/provider-registry";
import type { AccessDecision } from "../../src/security/access-control";
import type { OAuthExchangeResult } from "../../src/providers/authentication/oauth-flow-store";

/** A minimal in-memory Redis: only the `get`/`set`/`del` the flow store uses. */
function fakeRedis(): RedisClient {
  const store = new Map<string, string>();
  const client = {
    async set(key: string, value: string): Promise<"OK"> {
      store.set(key, value);
      return "OK";
    },
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async del(key: string): Promise<number> {
      return store.delete(key) ? 1 : 0;
    },
  };
  return client as unknown as RedisClient;
}

/** A fetch double answering the two AWS SSO OIDC calls a Builder ID login makes. */
function kiroFetch() {
  const calls: { url: string; body: string | undefined }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    const body = url.includes("/client/register")
      ? { clientId: "test-client-id", clientSecret: "test-client-secret" }
      : {
          accessToken: "placeholder-access",
          refreshToken: "placeholder-refresh",
          expiresIn: 3600,
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function harness() {
  const { calls, fetchFn } = kiroFetch();
  const client = new KiroOAuthClient(fetchFn);
  const flowStore = new OAuthFlowStore(fakeRedis());
  const persisted: ({ readonly label: string } & OAuthExchangeResult)[] = [];
  const accountStore = {
    async persistAccount(
      _tenantId: string | null,
      _providerId: string,
      input: { readonly label: string } & OAuthExchangeResult,
    ) {
      persisted.push(input);
      return { accountId: "acct-1" };
    },
  };
  const registry = {
    async resolveLoginClient(providerId: string) {
      return providerId === "kiro" ? client : undefined;
    },
  } as unknown as ProviderRegistry;
  // The loopback bind is replaced: the assertion is about the flow's wiring,
  // not about holding a real socket in a unit test.
  const callbackListener = new OAuthCallbackListener({
    completer: { complete: async () => ({ ok: true, message: "" }) },
    serve: () => ({ stop() {} }),
  });
  const config = {
    providerRegistry: registry,
    oauthFlowStore: flowStore,
    accountStore,
    accessResolver: () => undefined,
    callbackListener,
  };
  const access: AccessDecision = {
    id: "test",
    tenantId: "tenant-1",
    scopes: ["dashboard:write"],
    admissionIdentity: "test",
  };
  return { config, access, calls, persisted, operations: createOAuthLoginOperations(config) };
}

describe("Kiro Builder ID — console authorize wiring", () => {
  test("beginAuthorize returns the AWS SSO OIDC URL and files the registration privately", async () => {
    const { operations, access, calls, config } = harness();

    const started = await operations.beginAuthorize(access, "kiro", "kiro", {
      idp: "builder-id",
    });

    expect(started.authorizeUrl.startsWith("https://oidc.us-east-1.amazonaws.com/authorize?")).toBe(
      true,
    );
    expect(started.state.length).toBeGreaterThan(0);

    // The registration ran, for the loopback redirect AWS allowlists.
    const registration = calls.find((call) => call.url.includes("/client/register"));
    expect(registration).toBeDefined();
    const registrationBody = JSON.parse(registration?.body ?? "{}") as Record<string, unknown>;
    expect(registrationBody["grantTypes"]).toEqual(["authorization_code", "refresh_token"]);
    expect(registrationBody["redirectUris"]).toEqual(["http://127.0.0.1:59653"]);

    // The secret is filed as provider-private state, never returned to the browser.
    const flow = await config.oauthFlowStore.consumePending(started.state);
    expect(flow?.redirectUri).toBe("http://127.0.0.1:59653");
    expect(flow?.providerState).toContain("test-client-secret");
    expect(JSON.stringify(started)).not.toContain("test-client-secret");
  });

  test("completeLogin exchanges through AWS SSO OIDC and persists the credential the Kiro way", async () => {
    const { operations, access, calls, persisted, config } = harness();
    const started = await operations.beginAuthorize(access, "kiro", "kiro", {
      idp: "builder-id",
    });
    calls.length = 0;

    const outcome = await completeLogin(config, "kiro", "auth-code", started.state);

    expect(outcome.ok).toBe(true);
    // The token exchange went to AWS SSO OIDC with the authorization_code grant.
    const exchange = calls.find((call) => call.url.includes("/token"));
    expect(exchange).toBeDefined();
    const exchangeBody = JSON.parse(exchange?.body ?? "{}") as Record<string, unknown>;
    expect(exchangeBody["grantType"]).toBe("authorization_code");
    expect(exchangeBody["code"]).toBe("auth-code");

    // Persistence matches the existing Kiro device/social pattern: tokens plus
    // `auth_state` for the account-side configuration, and the client secret
    // beside them for the next refresh.
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.auth_state?.["authMethod"]).toBe("builder-id");
    expect(persisted[0]?.client_secret).toBe("test-client-secret");
  });

  test("the existing social path through the same route still targets the vendor service", async () => {
    const { operations, access, calls } = harness();

    const started = await operations.beginAuthorize(access, "kiro", "kiro", { idp: "google" });

    expect(
      started.authorizeUrl.startsWith("https://prod.us-east-1.auth.desktop.kiro.dev/login?"),
    ).toBe(true);
    // No registration is attempted for a social provider.
    expect(calls).toHaveLength(0);
  });
});
