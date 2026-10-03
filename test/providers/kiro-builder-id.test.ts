/**
 * Kiro browser login: the AWS Builder ID option alongside the existing social
 * path.
 *
 * The acceptance criterion is that an operator can pick AWS Builder ID from the
 * same "Login with browser" button that already offers Google and GitHub, and
 * that the flow it drives is the real one — not a renamed social flow. The two
 * families are genuinely different upstreams:
 *
 *  * Google/GitHub sign in at the vendor's own service
 *    (`prod.us-east-1.auth.desktop.kiro.dev/login`), which selects the provider
 *    with an `idp` query parameter and allowlists a custom-scheme redirect.
 *  * AWS Builder ID has no social endpoint. The vendor's `idp` enum is
 *    `[Github, Cognito, Google]`, so `idp=BuilderId` is refused with a 400
 *    validation error before consent. Builder ID signs in through AWS SSO OIDC:
 *    a public client is registered for the `authorization_code` grant, and the
 *    authorize URL redirects to the AWS access portal
 *    (`https://view.awsapps.com/start/`), where the operator signs in.
 *
 * The tests pin the parts of that contract that are easy to regress and were
 * verified against the live endpoint: the authorize URL shape, the repeated
 * `scope` encoding (AWS answers a joined value with `invalid_scope`), the
 * literal loopback redirect AWS allowlists, the token-endpoint exchange body,
 * and — most importantly — that the pre-existing social path is byte-for-byte
 * unchanged.
 *
 * No credential is printed: the fixtures are placeholders and the assertions
 * inspect structure, never a token value.
 */
import { describe, expect, test } from "bun:test";
import { KiroOAuthClient } from "../../src/providers/integrations/kiro/kiro-oauth";
import type { OAuthAuthorizeRequest } from "../../src/providers/authentication/oauth-flow-store";

/** A fetch double that records requests and answers a canned JSON body. */
function recordingFetch(responseBody: unknown, status = 200) {
  const calls: { url: string; method: string; body: string | undefined }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const REGISTRATION = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  clientIdIssuedAt: 1,
  clientSecretExpiresAt: 2,
};

/** A fetch double that answers per-path, so a flow's two calls differ. */
function routingFetch(routes: Readonly<Record<string, unknown>>) {
  const calls: { url: string; method: string; body: string | undefined }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const match = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    return new Response(JSON.stringify(match?.[1] ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function baseRequest(parameters?: Record<string, string>): OAuthAuthorizeRequest {
  return {
    state: "state-123",
    codeChallenge: "challenge-abc",
    redirectUri: "http://127.0.0.1:59653/callback",
    ...(parameters === undefined ? {} : { parameters }),
  };
}

describe("Kiro browser login — identity provider options", () => {
  test("the browser flow offers AWS Builder ID alongside Google and GitHub", () => {
    const client = new KiroOAuthClient();
    const field = client.browserLoginFields.find((entry) => entry.key === "idp");
    expect(field).toBeDefined();
    const values = (field?.options ?? []).map((option) => option.value);
    expect(values).toContain("google");
    expect(values).toContain("github");
    expect(values).toContain("builder-id");
  });
});

describe("Kiro browser login — AWS Builder ID authorize URL", () => {
  test("prepareAuthorize registers an authorization_code client and rewrites the redirect to the AWS loopback form", async () => {
    const { calls, fetchFn } = recordingFetch(REGISTRATION);
    const client = new KiroOAuthClient(fetchFn);

    const prepared = await client.prepareAuthorize(baseRequest({ idp: "builder-id" }));

    // One registration call, to the regional SSO OIDC endpoint.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://oidc.us-east-1.amazonaws.com/client/register");
    expect(calls[0]?.method).toBe("POST");
    const registrationBody = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(registrationBody["clientType"]).toBe("public");
    expect(registrationBody["grantTypes"]).toEqual(["authorization_code", "refresh_token"]);
    // The issuer is what a registration without one is refused for.
    expect(registrationBody["issuerUrl"]).toBe("https://view.awsapps.com/start");
    // AWS allowlists only the literal loopback with no path for a public client.
    expect(registrationBody["redirectUris"]).toEqual(["http://127.0.0.1:59653"]);

    // The request is rewritten so the redirect that is bound, filed and replayed
    // is the one AWS accepted.
    expect(prepared.redirectUri).toBe("http://127.0.0.1:59653");
    // The registration is stashed for the exchange and never sent to the browser.
    expect(prepared.parameters?.["builderIdClientId"]).toBe("test-client-id");
    expect(prepared.parameters?.["builderIdClientSecret"]).toBe("test-client-secret");
  });

  test("the authorize URL targets the AWS SSO OIDC endpoint and carries every scope as its own parameter", async () => {
    const { fetchFn } = recordingFetch(REGISTRATION);
    const client = new KiroOAuthClient(fetchFn);
    const prepared = await client.prepareAuthorize(baseRequest({ idp: "builder-id" }));

    const url = new URL(client.buildAuthorizeUrl(prepared));

    expect(url.origin + url.pathname).toBe("https://oidc.us-east-1.amazonaws.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:59653");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // Repeated `scope` parameters: AWS answers a space-joined value with
    // `invalid_scope`, so a single joined param would break the flow.
    expect(url.searchParams.getAll("scope")).toEqual([
      "codewhisperer:completions",
      "codewhisperer:analysis",
      "codewhisperer:conversations",
    ]);
    // The Builder ID path must never touch the vendor's social endpoint.
    expect(url.origin).not.toContain("desktop.kiro.dev");
  });
});

describe("Kiro browser login — existing social path is unchanged", () => {
  test("prepareAuthorize leaves a Google request untouched and makes no network call", async () => {
    const { calls, fetchFn } = recordingFetch(REGISTRATION);
    const client = new KiroOAuthClient(fetchFn);

    const request = baseRequest({ idp: "google" });
    const prepared = await client.prepareAuthorize(request);

    expect(prepared).toBe(request);
    expect(calls).toHaveLength(0);
  });

  test("the Google authorize URL is still the vendor social login with the custom-scheme redirect", () => {
    const client = new KiroOAuthClient();
    const url = new URL(client.buildAuthorizeUrl(baseRequest({ idp: "google" })));

    expect(url.origin + url.pathname).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/login");
    expect(url.searchParams.get("idp")).toBe("Google");
    expect(url.searchParams.get("redirect_uri")).toBe("kiro://kiro.kiroAgent/authenticate-success");
    expect(url.searchParams.get("prompt")).toBe("select_account");
  });

  test("the GitHub authorize URL still selects Github at the vendor social login", () => {
    const client = new KiroOAuthClient();
    const url = new URL(client.buildAuthorizeUrl(baseRequest({ idp: "github" })));
    expect(url.searchParams.get("idp")).toBe("Github");
  });

  test("a request with no idp defaults to the Google social path", () => {
    const client = new KiroOAuthClient();
    const url = new URL(client.buildAuthorizeUrl(baseRequest()));
    expect(url.origin + url.pathname).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/login");
    expect(url.searchParams.get("idp")).toBe("Google");
  });
});

describe("Kiro browser login — AWS Builder ID code exchange", () => {
  test("the code exchange posts the authorization_code grant with the registered client", async () => {
    const { calls, fetchFn } = routingFetch({
      "/client/register": REGISTRATION,
      "/token": {
        accessToken: "placeholder-access",
        refreshToken: "placeholder-refresh",
        expiresIn: 3600,
      },
    });
    const client = new KiroOAuthClient(fetchFn);
    const prepared = await client.prepareAuthorize(baseRequest({ idp: "builder-id" }));
    calls.length = 0;

    const result = await client.exchangeCode(
      "auth-code",
      "verifier-xyz",
      prepared.redirectUri,
      "state-123",
      { ...(prepared.parameters === undefined ? {} : { parameters: prepared.parameters }) },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://oidc.us-east-1.amazonaws.com/token");
    const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body["grantType"]).toBe("authorization_code");
    expect(body["clientId"]).toBe("test-client-id");
    expect(body["clientSecret"]).toBe("test-client-secret");
    expect(body["code"]).toBe("auth-code");
    expect(body["codeVerifier"]).toBe("verifier-xyz");
    expect(body["redirectUri"]).toBe("http://127.0.0.1:59653");

    // The credential persists the way the device flow does: the client secret
    // rides beside the tokens so every later refresh can replay it.
    expect(result.client_secret).toBe("test-client-secret");
    expect(result.auth_state?.["authMethod"]).toBe("builder-id");
    expect(result.auth_state?.["clientId"]).toBe("test-client-id");
  });

  test("the exchange refuses a flow whose registration was never recorded", async () => {
    const { fetchFn } = recordingFetch({});
    const client = new KiroOAuthClient(fetchFn);
    await expect(
      client.exchangeCode("auth-code", "verifier", "http://127.0.0.1:59653", "state-123", {
        parameters: { idp: "builder-id" },
      }),
    ).rejects.toThrow(/client registration/);
  });

  test("the social exchange is still chosen when the context names no Builder ID", async () => {
    const { calls, fetchFn } = recordingFetch({
      accessToken: "placeholder-access",
      refreshToken: "placeholder-refresh",
      expiresIn: 3600,
    });
    const client = new KiroOAuthClient(fetchFn);

    await client.exchangeCode("auth-code", "verifier", "http://127.0.0.1:59653", "state-123", {
      parameters: { idp: "google" },
    });

    expect(calls[0]?.url).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token");
  });
});
