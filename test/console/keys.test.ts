import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../../src/app";
import { findApiKeyBySecret } from "../../src/console/db/repos/api-keys";
import { insertUsageHistory } from "../../src/console/db/repos/usage";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";

beforeEach(() => {
  useIsolatedDataDir();
});

function authed(path: string, cookie: string): Request {
  return new Request(`http://localhost${path}`, { headers: { cookie } });
}

describe("console keys API", () => {
  test("accepts a custom secret prefix and sanitizes unsafe characters", async () => {
    const cookie = await loginAndGetCookie();

    const custom = await app.handle(postJson("/console/api/keys", { name: "custom-prefix-key", prefix: "sk-carte" }, { cookie }));
    expect(custom.status).toBe(201);
    const customBody = (await custom.json()) as { key: string; keyPrefix: string };
    expect(customBody.key.startsWith("sk-carte_")).toBe(true);
    expect(customBody.keyPrefix).toBe(customBody.key.slice(0, 12));

    // Anything outside [A-Za-z0-9_-] is stripped rather than rejected -
    // no validation error, per product decision ("ya valid aja").
    const messy = await app.handle(postJson("/console/api/keys", { name: "messy-prefix-key", prefix: "sk carte!! \u2764" }, { cookie }));
    expect(messy.status).toBe(201);
    const messyBody = (await messy.json()) as { key: string };
    expect(messyBody.key.startsWith("skcarte_")).toBe(true);

    // A blank/whitespace-only prefix falls back to the default, not an empty segment.
    const blank = await app.handle(postJson("/console/api/keys", { name: "blank-prefix-key", prefix: "   " }, { cookie }));
    expect(blank.status).toBe(201);
    const blankBody = (await blank.json()) as { key: string };
    expect(blankBody.key.startsWith("ctk_")).toBe(true);
  });

  test("list includes today/total token usage per key from usage history", async () => {
    const cookie = await loginAndGetCookie();
    const created = await app.handle(postJson("/console/api/keys", { name: "usage-key" }, { cookie }));
    const { id, key } = (await created.json()) as { id: string; key: string };

    const fresh = await app.handle(authed("/console/api/keys", cookie));
    const freshItems = ((await fresh.json()) as { items: { id: string; todayTokens: number; totalTokens: number }[] }).items;
    expect(freshItems.find((item) => item.id === id)?.todayTokens).toBe(0);
    expect(freshItems.find((item) => item.id === id)?.totalTokens).toBe(0);

    insertUsageHistory({
      traceId: crypto.randomUUID(),
      endpoint: "/v1/chat/completions",
      surface: "chat",
      apiKeyId: id,
      apiKeyPrefix: key.slice(0, 12),
      provider: "kimchi",
      model: "kimchi/kimi-k2.7",
      status: 200,
      errorKind: null,
      stream: false,
      startedAt: new Date().toISOString().replace("T", " ").replace("Z", ""),
      finishedAt: new Date().toISOString().replace("T", " ").replace("Z", ""),
      durationMs: 10,
      inputTokens: 40,
      outputTokens: 60,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: 100,
      usageSource: "test",
      meta: {},
    });

    const after = await app.handle(authed("/console/api/keys", cookie));
    const afterItems = ((await after.json()) as { items: { id: string; todayTokens: number; totalTokens: number }[] }).items;
    const row = afterItems.find((item) => item.id === id);
    expect(row?.todayTokens).toBe(100);
    expect(row?.totalTokens).toBe(100);
  });

  test("login → create → list → revoke → reject revoked", async () => {
    const cookie = await loginAndGetCookie();

    const empty = await app.handle(authed("/console/api/keys", cookie));
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { items: unknown[] }).items.length).toBe(0);

    const created = await app.handle(postJson("/console/api/keys", { name: "ci-key" }, { cookie }));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { key: string; keyPrefix: string; id: string };
    expect(createdBody.key.startsWith("ctk_")).toBe(true);
    expect(createdBody.keyPrefix).toBe(createdBody.key.slice(0, 12));

    const listed = await app.handle(authed("/console/api/keys", cookie));
    const items = ((await listed.json()) as { items: { name: string; keyPrefix: string }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.name).toBe("ci-key");
    expect(JSON.stringify(items[0])).not.toContain(createdBody.key.slice(12));

    const revoked = await app.handle(postJson(`/console/api/keys/${createdBody.id}/revoke`, {}, { cookie }));
    expect(revoked.status).toBe(200);
    const found = findApiKeyBySecret(createdBody.key);
    expect(found).not.toBeNull();
    expect(found!.active).toBe(false);

    const again = await app.handle(postJson(`/console/api/keys/${createdBody.id}/revoke`, {}, { cookie }));
    expect(again.status).toBe(404);
  });

  test("duplicate key name is rejected with 409", async () => {
    const cookie = await loginAndGetCookie();
    await app.handle(postJson("/console/api/keys", { name: "dup" }, { cookie }));
    const dup = await app.handle(postJson("/console/api/keys", { name: "dup" }, { cookie }));
    expect(dup.status).toBe(409);
  });

  test("PATCH updates limits and ACL fields", async () => {
    const cookie = await loginAndGetCookie();
    const created = await app.handle(postJson("/console/api/keys", { name: "editable-key" }, { cookie }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const updated = await app.handle(
      new Request(`http://localhost/console/api/keys/${id}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          rateLimitRpm: 30,
          monthlyTokenLimit: 5000,
          maxConcurrentRequests: 2,
          modelAllowlist: ["kimchi/kimi-k2.7"],
          modelDenylist: ["cmd/gpt-5-codex"],
        }),
      })
    );
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as {
      rateLimitRpm: number | null;
      monthlyTokenLimit: number | null;
      maxConcurrentRequests: number | null;
      modelAllowlist: string[] | null;
      modelDenylist: string[] | null;
    };
    expect(body.rateLimitRpm).toBe(30);
    expect(body.monthlyTokenLimit).toBe(5000);
    expect(body.maxConcurrentRequests).toBe(2);
    expect(body.modelAllowlist).toEqual(["kimchi/kimi-k2.7"]);
    expect(body.modelDenylist).toEqual(["cmd/gpt-5-codex"]);
  });

  test("concurrent requests for the same key name produce one record and one conflict", async () => {
    const cookie = await loginAndGetCookie();
    const [first, second] = await Promise.all([
      app.handle(postJson("/console/api/keys", { name: "concurrent" }, { cookie })),
      app.handle(postJson("/console/api/keys", { name: "concurrent" }, { cookie })),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const listed = await app.handle(authed("/console/api/keys", cookie));
    expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  test("the credential endpoint reveals the plaintext key only to an authenticated session", async () => {
    const cookie = await loginAndGetCookie();
    const created = await app.handle(postJson("/console/api/keys", { name: "reveal-key" }, { cookie }));
    expect(created.status).toBe(201);
    const { id, key } = (await created.json()) as { id: string; key: string };

    const revealed = await app.handle(authed(`/console/api/keys/${id}/credential`, cookie));
    expect(revealed.status).toBe(200);
    expect(((await revealed.json()) as { key: string }).key).toBe(key);

    const anonymous = await app.handle(new Request(`http://localhost/console/api/keys/${id}/credential`));
    expect(anonymous.status).toBe(401);

    const ghost = await app.handle(authed("/console/api/keys/ghost/credential", cookie));
    expect(ghost.status).toBe(404);
  });

  test("password change invalidates the old session (stale pv)", async () => {
    const cookie = await loginAndGetCookie();
    const changed = await app.handle(
      postJson("/console/api/settings/password", { currentPassword: "carte1234", newPassword: "newsecret1", confirmPassword: "newsecret1" }, { cookie })
    );
    expect(changed.status).toBe(200);
    const after = await app.handle(authed("/console/api/keys", cookie));
    expect(after.status).toBe(401);
    const relogin = await loginAndGetCookie("newsecret1");
    const ok = await app.handle(authed("/console/api/keys", relogin));
    expect(ok.status).toBe(200);
  });

  test("logout-all bumps pv and rejects the old cookie", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(postJson("/console/api/settings/logout-all", { password: "carte1234" }, { cookie }));
    expect(res.status).toBe(200);
    const after = await app.handle(authed("/console/api/keys", cookie));
    expect(after.status).toBe(401);
  });

  test("wrong current password on change is rejected", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(
      postJson("/console/api/settings/password", { currentPassword: "nope", newPassword: "newsecret1", confirmPassword: "newsecret1" }, { cookie })
    );
    expect(res.status).toBe(401);
  });
});
