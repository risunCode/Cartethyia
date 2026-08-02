import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { app } from "../../src/app";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";
import { tokenKeeper } from "../../src/tokenkeeper";

function response(body: unknown): Response {
  return Response.json(body);
}

describe("OAuth control API", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  beforeEach(() => {
    useIsolatedDataDir();
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    tokenKeeper.stop();
  });

  test("starts, polls, and cancels a Codex Authorization Code session", async () => {
    const cookie = await loginAndGetCookie();
    const started = await app.handle(postJson("/console/api/providers/openai-codex/oauth/login", { name: "Codex console" }, { cookie }));
    expect(started.status).toBe(200);
    const startBody = (await started.json()) as { sessionId: string; status: string; authorizationUrl: string };
    expect(startBody.status).toBe("waiting-for-user");
    expect(startBody.authorizationUrl).toContain("code_challenge_method=S256");
    expect(startBody.authorizationUrl).not.toContain("device");

    const polled = await app.handle(new Request(`http://localhost/console/api/oauth/login/${startBody.sessionId}`, { headers: { cookie } }));
    expect(polled.status).toBe(200);
    expect((await polled.json()) as { status: string }).toMatchObject({ status: "waiting-for-user" });

    const cancelled = await app.handle(new Request(`http://localhost/console/api/oauth/login/${startBody.sessionId}/cancel`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }));
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ ok: true });
  });

  test("completes a Codex session through the protected API", async () => {
    const cookie = await loginAndGetCookie();
    const started = await app.handle(postJson("/console/api/providers/openai-codex/oauth/login", { name: "Codex API" }, { cookie }));
    const startBody = (await started.json()) as { sessionId: string; authorizationUrl: string };
    const state = new URL(startBody.authorizationUrl).searchParams.get("state");
    const payload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "api-workspace", chatgpt_plan_type: "plus" },
      "https://api.openai.com/profile": { email: "api@example.com" },
    })).toString("base64url");
    fetchSpy.mockResolvedValueOnce(response({
      access_token: `header.${payload}.signature`,
      refresh_token: "api-refresh-token",
      expires_in: 3600,
    }));

    const completed = await app.handle(postJson(
      `/console/api/oauth/login/${startBody.sessionId}/complete`,
      { value: `http://localhost:1455/auth/callback?code=api-code&state=${encodeURIComponent(state ?? "")}` },
      { cookie },
    ));
    expect(completed.status).toBe(200);
    expect((await completed.json()) as { status: string; accountId?: string }).toMatchObject({ status: "completed" });
  });
});
