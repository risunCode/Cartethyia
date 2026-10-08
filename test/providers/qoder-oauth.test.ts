import { describe, expect, test } from "bun:test";
import {
  parseQoderExpiry,
  parseQoderOAuthState,
  QoderOAuthClient,
} from "../../src/providers/integrations/qoder-oauth";
import {
  isQoderPat,
  qoderMachineIdForAccount,
  qoderOAuthAuth,
} from "../../src/providers/integrations/qoder";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(fetcher: (url: string, init?: RequestInit) => Promise<Response>): QoderOAuthClient {
  return new QoderOAuthClient(fetcher as typeof fetch);
}

describe("Qoder device flow start", () => {
  test("builds a local verification URI with PKCE, nonce, and machine id", async () => {
    const client = clientWith(async () => {
      throw new Error("start must not touch the network");
    });
    const started = await client.startDeviceAuth();
    expect(started.verificationUri.startsWith("https://qoder.com/device/selectAccounts?")).toBe(true);
    expect(started.verificationUri).toContain("challenge_method=S256");
    expect(started.deviceAuthId.length).toBeGreaterThan(0);
    expect(started.userCode).toBe("");
    const state = JSON.parse(started.providerState ?? "{}") as Record<string, unknown>;
    expect(typeof state.verifier).toBe("string");
    expect(typeof state.machineId).toBe("string");
  });
});

describe("Qoder device flow poll", () => {
  const providerState = JSON.stringify({ verifier: "verifier-value", machineId: "machine-value" });

  test("202 and 404 mean keep polling", async () => {
    for (const status of [202, 404]) {
      const client = clientWith(async () => new Response("", { status }));
      const result = await client.pollDeviceAuth("nonce-value", {
        providerId: "qoder",
        tenantId: null,
        accountLabel: "",
        providerState,
      });
      expect(result).toEqual({ status: "pending" });
    }
  });

  test("a missing device state fails closed", async () => {
    const client = clientWith(async () => jsonResponse({}));
    const result = await client.pollDeviceAuth("nonce-value", {
      providerId: "qoder",
      tenantId: null,
      accountLabel: "",
    });
    expect(result.status).toBe("failed");
  });

  test("a 200 without a token fails instead of storing an empty credential", async () => {
    const client = clientWith(async () => jsonResponse({ ok: true }));
    const result = await client.pollDeviceAuth("nonce-value", {
      providerId: "qoder",
      tenantId: null,
      accountLabel: "",
      providerState,
    });
    expect(result.status).toBe("failed");
  });

  test("a token completes with auth_state identity and account label", async () => {
    const client = clientWith(async (url) => {
      if (typeof url === "string" && url.includes("deviceToken")) {
        return jsonResponse({
          token: "dt-test-token",
          refresh_token: "rt-test",
          user_id: "user-123",
          expires_in: 2_592_000,
        });
      }
      return jsonResponse({ name: "Ada", email: "ada@example.com", id: "user-123" });
    });
    const result = await client.pollDeviceAuth("nonce-value", {
      providerId: "qoder",
      tenantId: null,
      accountLabel: "",
      providerState,
    });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.result.access).toBe("dt-test-token");
    expect(result.result.refresh).toBe("rt-test");
    expect(result.result.accountLabel).toBe("Ada");
    expect(result.result.auth_state).toEqual({ userId: "user-123", machineId: "machine-value" });
  });

  test("a failed userinfo lookup still completes the login", async () => {
    const client = clientWith(async (url) => {
      if (typeof url === "string" && url.includes("deviceToken")) {
        return jsonResponse({ token: "dt-test-token", user_id: "user-9" });
      }
      return new Response("boom", { status: 500 });
    });
    const result = await client.pollDeviceAuth("nonce-value", {
      providerId: "qoder",
      tenantId: null,
      accountLabel: "",
      providerState,
    });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.result.auth_state).toEqual({ userId: "user-9", machineId: "machine-value" });
    expect(result.result.accountLabel).toBeUndefined();
  });
});

describe("parseQoderExpiry", () => {
  test("accepts ms-epoch numbers, numeric strings, and RFC3339", () => {
    expect(parseQoderExpiry(1_786_622_470_000, undefined)).toBe(1_786_622_470_000);
    expect(parseQoderExpiry("1786622470000", undefined)).toBe(1_786_622_470_000);
    expect(parseQoderExpiry("2026-06-16T07:15:04Z", undefined)).toBe(Date.parse("2026-06-16T07:15:04Z"));
  });

  test("falls back to seconds-from-now, then to 30 days", () => {
    const before = Date.now();
    const fromSeconds = parseQoderExpiry(undefined, 3600);
    expect(fromSeconds).toBeGreaterThanOrEqual(before + 3_599_000);
    const fallback = parseQoderExpiry(undefined, undefined);
    expect(fallback).toBeGreaterThanOrEqual(before + 29 * 24 * 60 * 60 * 1000);
  });
});

describe("Qoder dispatch credential branches", () => {
  test("only pt- secrets take the PAT exchange path", () => {
    expect(isQoderPat("pt-abc")).toBe(true);
    expect(isQoderPat("dt-abc")).toBe(false);
    expect(isQoderPat("jt-abc")).toBe(false);
    expect(isQoderPat("")).toBe(false);
  });

  test("machine ids are stable per account and distinct across accounts", () => {
    expect(qoderMachineIdForAccount("a")).toBe(qoderMachineIdForAccount("a"));
    expect(qoderMachineIdForAccount("a")).not.toBe(qoderMachineIdForAccount("b"));
  });

  test("OAuth auth uses the token directly with the persisted identity", () => {
    const auth = qoderOAuthAuth(
      "dt-test-token",
      { userId: "user-123", machineId: "machine-value" },
      "account-1",
    );
    expect(auth).toMatchObject({
      userId: "user-123",
      securityOauthToken: "dt-test-token",
      machineId: "machine-value",
    });
  });

  test("OAuth auth without an identity fails closed", () => {
    expect(() => qoderOAuthAuth("dt-test-token", {}, "account-1")).toThrow(
      /sign in again/,
    );
    expect(() => qoderOAuthAuth("dt-test-token", undefined, "account-1")).toThrow(
      /sign in again/,
    );
  });

  test("parseQoderOAuthState rejects identity without both fields", () => {
    expect(parseQoderOAuthState({ userId: "u", machineId: "m" })).toEqual({
      userId: "u",
      machineId: "m",
    });
    expect(parseQoderOAuthState({ userId: "u" })).toBeUndefined();
    expect(parseQoderOAuthState(null)).toBeUndefined();
  });
});
