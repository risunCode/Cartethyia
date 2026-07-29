import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../../src/app";
import { findApiKeyBySecret } from "../../src/console/db/repos/api-keys";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";

beforeEach(() => {
  useIsolatedDataDir();
});

function authed(path: string, cookie: string): Request {
  return new Request(`http://localhost${path}`, { headers: { cookie } });
}

describe("console keys API", () => {
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
