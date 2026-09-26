import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexDeviceStart, pollCodexDeviceAuth, startCodexDeviceAuth } from "../../../../src/providers/integrations/codex/codex-device-code";
import { createCodexIdentity, filterCodexMetadata, getCodexAccountId, getCodexInstallId, getCodexResidency } from "../../../../src/providers/integrations/codex/codex-identity";
import { CODEX_CLIENT_ID, CODEX_DEVICE_REDIRECT_URI, CodexOAuthClient } from "../../../../src/providers/integrations/codex/codex-oauth";
import { OAuthFlowStore } from "../../../../src/providers/authentication/oauth-flow-store";
import type { RedisClient } from "../../../../src/persistence/redis";

describe("Codex OAuth and Identity Integration", () => {
  describe("codex-oauth.test.ts", () => {
    function fakeRedis(shared?: Map<string, string>): RedisClient {
      const store = shared ?? new Map<string, string>();
      return {
        set: async (key: string, value: string) => {
          store.set(key, value);
          return "OK";
        },
        get: async (key: string) => store.get(key) ?? null,
        del: async (key: string) => (store.delete(key) ? 1 : 0),
        eval: async (_script: string, _numKeys: number, ...args: string[]) => {
          const key = args[0];
          if (!key) return null;
          const v = store.get(key) ?? null;
          if (v) store.delete(key);
          return v;
        },
      } as unknown as RedisClient;
    }

    function codexAccessToken(): string {
      return `header.${Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
          "https://api.openai.com/profile": { email: "user@example.test" },
        }),
      ).toString("base64url")}.signature`;
    }

    describe("identity.test.ts", () => {
      let directory: string | undefined;
      afterEach(async () => {
        if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      });

      describe("Codex identity", () => {
        test("persists installation id", async () => {
          directory = await mkdtemp(join(tmpdir(), "cartethyia-codex-"));
          const path = join(directory, "id");
          const first = await getCodexInstallId(path);
          expect(await getCodexInstallId(path)).toBe(first);
          expect((await readFile(path, "utf8")).trim()).toBe(first);
        });
        test("generates lifecycle ids and strips reserved metadata", () => {
          const identity = createCodexIdentity("session");
          expect(identity.session_id).toBe("session");
          expect(identity.thread_id).toMatch(/^[0-9a-f-]{36}$/);
          expect(filterCodexMetadata({ session_id: "fake", ok: 1 })).toEqual({ ok: 1 });
        });
        test("extracts JWT account and residency, opaque token does not", () => {
          const payload = Buffer.from(
            JSON.stringify({ chatgpt_account_id: "acct", chatgpt_data_residency: "us" }),
          ).toString("base64url");
          const token = `a.${payload}.c`;
          expect(getCodexAccountId(token)).toBe("acct");
          expect(getCodexResidency({ accessToken: token })).toBe("us");
          expect(getCodexResidency({ accessToken: token, override: "eu" })).toBe("eu");
          expect(getCodexAccountId("opaque")).toBeUndefined();
        });
      });
    });

    describe("device-code.test.ts", () => {
      describe("Codex device authorization", () => {
        test("returns pending until the user approves, then the PKCE pair", async () => {
          // One poll attempt per call. The dashboard owns the cadence, so the
          // console route must not hold a request open for the whole window.
          let calls = 0;
          const fetchFn = (async (_url: string | URL | Request, _init?: RequestInit) => {
            calls += 1;
            if (calls === 1)
              return new Response(
                JSON.stringify({ device_auth_id: "d", user_code: "code", interval: 0 }),
                { status: 200 },
              );
            if (calls < 4) return new Response("", { status: 403 });
            return new Response(JSON.stringify({ authorization_code: "auth", code_verifier: "ver" }), {
              status: 200,
            });
          }) as unknown as typeof fetch;
          const started = await startCodexDeviceAuth("client", fetchFn);
          // 403 is "not approved yet" — pending, not a failure.
          expect(await pollCodexDeviceAuth(started, fetchFn)).toBeUndefined();
          expect(await pollCodexDeviceAuth(started, fetchFn)).toBeUndefined();
          const result = await pollCodexDeviceAuth(started, fetchFn);
          expect(result?.authorizationCode).toBe("auth");
          expect(calls).toBe(4);
        });
        test("distinguishes a real error from a pending answer", async () => {
          const device = { deviceAuthId: "d", userCode: "u", intervalSeconds: 0 };
          // 404 is the endpoint's other "not approved yet" answer.
          const pending = (async (_url: string | URL | Request, _init?: RequestInit) =>
            new Response("", { status: 404 })) as unknown as typeof fetch;
          expect(await pollCodexDeviceAuth(device, pending)).toBeUndefined();
          // Anything else is a real failure and must surface.
          const failed = (async (_url: string | URL | Request, _init?: RequestInit) =>
            new Response("", { status: 500 })) as unknown as typeof fetch;
          await expect(pollCodexDeviceAuth(device, failed)).rejects.toThrow("500");
        });
        test("a not-yet-approved poll returns pending and keeps the state for a retry", async () => {
          // The dashboard polls on its own interval. Returning `pending` — not
          // blocking, and not a failure — is what makes the dialog's countdown
          // and interval mean anything; and the device state must survive so
          // the next attempt can still complete.
          let calls = 0;
          const fetchFn = (async (_url: string | URL | Request, _init?: RequestInit) => {
            calls += 1;
            if (calls === 1)
              return new Response(JSON.stringify({ device_auth_id: "d3", user_code: "u3", interval: 0 }));
            if (calls === 2) return new Response("", { status: 403 });
            if (calls === 3)
              return new Response(JSON.stringify({ authorization_code: "a3", code_verifier: "v3" }));
            return new Response(
              JSON.stringify({ access_token: codexAccessToken(), refresh_token: "y", expires_in: 60 }),
            );
          }) as unknown as typeof fetch;
          const store = new OAuthFlowStore(fakeRedis());
          const client = new CodexOAuthClient(fetchFn, store);
          const started = await client.startDeviceAuth();
          expect((await client.pollDeviceAuth(started.deviceAuthId)).status).toBe("pending");
          // The pending attempt must not have discarded the authorization.
          expect(await store.getDeviceState(started.deviceAuthId)).toBeDefined();
          expect((await client.pollDeviceAuth(started.deviceAuthId)).status).toBe("complete");
        });

        test("device state survives a failed exchange so the operator can retry", async () => {
          // The authorization code is single-use; dropping the state before the
          // exchange would strand a failure with no way to retry.
          let calls = 0;
          const fetchFn = (async (_url: string | URL | Request, _init?: RequestInit) => {
            calls += 1;
            if (calls === 1)
              return new Response(JSON.stringify({ device_auth_id: "d4", user_code: "u4", interval: 0 }));
            if (calls === 2)
              return new Response(JSON.stringify({ authorization_code: "a4", code_verifier: "v4" }));
            return new Response('{"error":"server_error"}', { status: 500 });
          }) as unknown as typeof fetch;
          const store = new OAuthFlowStore(fakeRedis());
          const client = new CodexOAuthClient(fetchFn, store);
          const started = await client.startDeviceAuth();
          await expect(client.pollDeviceAuth(started.deviceAuthId)).rejects.toThrow();
          expect(await store.getDeviceState(started.deviceAuthId)).toBeDefined();
        });

        test("parseCodexDeviceStart accepts valid persisted state and rejects malformed state", () => {
          expect(parseCodexDeviceStart({ deviceAuthId: "d", userCode: "u", intervalSeconds: 5 })).toEqual({
            deviceAuthId: "d",
            userCode: "u",
            intervalSeconds: 5,
          });
          expect(parseCodexDeviceStart({ deviceAuthId: "d", userCode: "u" })).toBeUndefined();
          expect(
            parseCodexDeviceStart({ deviceAuthId: "d", userCode: "u", intervalSeconds: "5" }),
          ).toBeUndefined();
          expect(parseCodexDeviceStart({ deviceAuthId: 1, userCode: "u", intervalSeconds: 5 })).toBeUndefined();
        });
      });
    });

    describe("oauth.test.ts", () => {
      describe("Codex OAuth", () => {
        test("builds the locked browser authorize URL", () => {
          const originalOrigin = process.env.CARTETHYIA_PUBLIC_ORIGIN;
          process.env.CARTETHYIA_PUBLIC_ORIGIN = "https://example.test";
          try {
            const authorizeUrl = new CodexOAuthClient().buildAuthorizeUrl({
              state: "s",
              codeChallenge: "c",
              redirectUri: "http://127.0.0.1:59653/callback",
            });
            const params = new URL(authorizeUrl).searchParams;
            expect(params.get("client_id")).toBe(CODEX_CLIENT_ID);
            expect(params.get("redirect_uri")).toBe(
              "http://127.0.0.1:59653/callback",
            );
            expect(params.get("originator")).toBe("codex_cli_rs");
            expect(params.get("codex_cli_simplified_flow")).toBeNull();
            expect(params.get("id_token_add_organizations")).toBeNull();
          } finally {
            if (originalOrigin === undefined) delete process.env.CARTETHYIA_PUBLIC_ORIGIN;
            else process.env.CARTETHYIA_PUBLIC_ORIGIN = originalOrigin;
          }
        });
        test("exchanges browser code and refreshes without org assumptions", async () => {
          const seen: RequestInit[] = [];
          const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
            seen.push(init ?? {});
            return new Response(
              JSON.stringify({ access_token: codexAccessToken(), refresh_token: "r", expires_in: 60 }),
              { status: 200 },
            );
          }) as unknown as typeof fetch;
          const client = new CodexOAuthClient(fetchFn);
          const originalOrigin = process.env.CARTETHYIA_PUBLIC_ORIGIN;
          process.env.CARTETHYIA_PUBLIC_ORIGIN = "https://example.test";
          try {
            expect((await client.exchangeCode("code", "ver", "http://127.0.0.1:59653/callback")).accountLabel).toBe("user@example.test");
            expect((await client.refresh("r")).refresh).toBe("r");
            expect(String(seen[0]?.body)).toContain(
              encodeURIComponent("http://127.0.0.1:59653/callback"),
            );
            expect(String(seen[1]?.body)).toContain("grant_type=refresh_token");
          } finally {
            if (originalOrigin === undefined) delete process.env.CARTETHYIA_PUBLIC_ORIGIN;
            else process.env.CARTETHYIA_PUBLIC_ORIGIN = originalOrigin;
          }
        });
        test("rejects browser token responses without a finite expiry or account identity", async () => {
          const originalOrigin = process.env.CARTETHYIA_PUBLIC_ORIGIN;
          process.env.CARTETHYIA_PUBLIC_ORIGIN = "https://example.test";
          try {
            const invalidExpiry = new CodexOAuthClient(
              (async () =>
                new Response(JSON.stringify({ access_token: codexAccessToken(), refresh_token: "r" }))) as unknown as typeof fetch,
            );
            await expect(invalidExpiry.exchangeCode("code", "ver", "http://127.0.0.1:59653/callback")).rejects.toThrow("expires_in");
            const invalidIdentity = new CodexOAuthClient(
              (async () =>
                new Response(JSON.stringify({ access_token: "opaque", refresh_token: "r", expires_in: 60 }))) as unknown as typeof fetch,
            );
            await expect(invalidIdentity.exchangeCode("code", "ver", "http://127.0.0.1:59653/callback")).rejects.toThrow("identity");
          } finally {
            if (originalOrigin === undefined) delete process.env.CARTETHYIA_PUBLIC_ORIGIN;
            else process.env.CARTETHYIA_PUBLIC_ORIGIN = originalOrigin;
          }
        });
        test("allows refresh responses without a replacement refresh token and preserves errors", async () => {
          const client = new CodexOAuthClient(
            (async () =>
              new Response(JSON.stringify({ access_token: "new-access", expires_in: 60 }))) as unknown as typeof fetch,
          );
          expect(await client.refresh("old-refresh")).toMatchObject({ access: "new-access" });
          expect((await client.refresh("old-refresh")).refresh).toBeUndefined();
          const rejected = new CodexOAuthClient(
            (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch,
          );
          await expect(rejected.refresh("old-refresh")).rejects.toThrow("invalid_grant");
        });
        test("device completion exchanges using HTTPS redirect", async () => {
          let calls = 0;
          const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
            calls += 1;
            if (calls === 1)
              return new Response(JSON.stringify({ device_auth_id: "d", user_code: "u", interval: 0 }));
            if (calls === 2)
              return new Response(JSON.stringify({ authorization_code: "a", code_verifier: "v" }));
            expect(String(init?.body)).toContain(encodeURIComponent(CODEX_DEVICE_REDIRECT_URI));
            return new Response(
              JSON.stringify({ access_token: codexAccessToken(), refresh_token: "y", expires_in: 60 }),
            );
          }) as unknown as typeof fetch;
          const store = new OAuthFlowStore(fakeRedis());
          const client = new CodexOAuthClient(fetchFn, store);
          await client.startDeviceAuth();
          expect((await client.pollDeviceAuth("d")).status).toBe("complete");
        });
        test("Codex device state survives restart via Redis (fresh client, same backing)", async () => {
          const shared = new Map<string, string>();
          const backing = () => fakeRedis(shared);
          let calls = 0;
          const fetchFn = (async (_url: string | URL | Request) => {
            calls += 1;
            if (calls === 1)
              return new Response(JSON.stringify({ device_auth_id: "d2", user_code: "u2", interval: 0 }));
            if (calls === 2)
              return new Response(JSON.stringify({ authorization_code: "a2", code_verifier: "v2" }));
            return new Response(
              JSON.stringify({ access_token: codexAccessToken(), refresh_token: "y", expires_in: 60 }),
            );
          }) as unknown as typeof fetch;
          const clientA = new CodexOAuthClient(fetchFn, new OAuthFlowStore(backing()));
          const started = await clientA.startDeviceAuth();
          expect(started.deviceAuthId).toBe("d2");
          // Simulate restart: new client instance, same Redis backing
          const clientB = new CodexOAuthClient(fetchFn, new OAuthFlowStore(backing()));
          const polled = await clientB.pollDeviceAuth("d2");
          expect(polled.status).toBe("complete");
        });
      });
    });
  });
});
