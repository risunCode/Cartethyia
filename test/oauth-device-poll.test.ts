import { describe, expect, test } from "bun:test";
import { ClineOAuthDriver } from "../src/application/auth/oauth/cline";
import { GrokBuildOAuthDriver } from "../src/application/auth/oauth/grokbuild";
import { KiroOAuthDriver } from "../src/application/auth/oauth/kiro";

type JsonValue = Record<string, unknown>;

function jsonResponse(value: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("OAuth device polling through the shared hardened transport", () => {
  test("Cline preserves authorization_pending without bypassing the client", async () => {
    const requests: RequestInit[] = [];
    const responses = [
      jsonResponse({ device_code: "cline-device", user_code: "CLINE-CODE", verification_uri: "https://cline.example/verify" }),
      jsonResponse({ error: "authorization_pending" }, 400),
    ];
    const driver = new ClineOAuthDriver({ fetch: async (_input, init) => { requests.push(init ?? {}); return responses.shift()!; }, nowMs: () => 1_000 });

    const started = await driver.start({ providerId: "cline", state: "cline-state" });
    await expect(driver.poll(started.state)).resolves.toEqual({ status: "pending" });
    expect(requests).toHaveLength(2);
    expect(requests.every((init) => init.redirect === "manual" && init.signal instanceof AbortSignal)).toBe(true);
  });

  test("Grok Build preserves slow_down without following redirects", async () => {
    const requests: RequestInit[] = [];
    const responses = [
      jsonResponse({ device_code: "grok-device", user_code: "GROK-CODE", verification_uri: "https://grok.example/verify" }),
      jsonResponse({ error: "slow_down" }, 400),
    ];
    const driver = new GrokBuildOAuthDriver({ fetch: async (_input, init) => { requests.push(init ?? {}); return responses.shift()!; }, nowMs: () => 1_000 });

    const started = await driver.start({ providerId: "grok-build" });
    await expect(driver.poll(started.state)).resolves.toEqual({ status: "pending" });
    expect(requests).toHaveLength(2);
    expect(requests.every((init) => init.redirect === "manual")).toBe(true);
  });

  test("Kiro device polling classifies pending responses from bounded JSON", async () => {
    const responses = [
      jsonResponse({ clientId: "kiro-client", clientSecret: "kiro-secret" }),
      jsonResponse({ deviceCode: "kiro-device", userCode: "KIRO-CODE", verificationUri: "https://kiro.example/verify" }),
      jsonResponse({ error: "authorization_pending" }, 400),
    ];
    const driver = new KiroOAuthDriver({ fetch: async () => responses.shift()!, nowMs: () => 1_000 });

    const started = await driver.start({ providerId: "kiro", state: "kiro-state" });
    await expect(driver.poll(started.state)).resolves.toEqual({ status: "pending", intervalSeconds: 5 });
  });
});
