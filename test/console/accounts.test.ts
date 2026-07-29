/** Provider accounts tests - CRUD and plaintext credential storage (REQ-3.7, REQ-20). */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { app } from "../../src/app";
import { getDb } from "../../src/console/db/client";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";
import { resetOpenCodeFreeCatalogForTests } from "../../src/upstream/providers/opencode-free/catalog";

type MockFetch = ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

let fetchSpy: MockFetch;

beforeEach(() => {
  useIsolatedDataDir();
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  resetOpenCodeFreeCatalogForTests();
  fetchSpy.mockRestore();
});

function authed(path: string, cookie: string): Request {
  return new Request(`http://localhost${path}`, { headers: { cookie } });
}

function deleteJson(path: string, cookie: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", cookie },
  });
}

function seedProxyPool(name: string): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .query("INSERT INTO proxy_pools (id, name, entries_json, no_proxy, strict_proxy, created_at, updated_at) VALUES (?, ?, ?, '', 0, ?, ?)")
    .run(id, name, JSON.stringify([{ url: "http://localhost:8080", scheme: "http" }]), now, now);
  return id;
}

describe("provider accounts CRUD", () => {
  test("create → list → patch → delete on opencode-free (bearer default)", async () => {
    const cookie = await loginAndGetCookie();

    const created = await app.handle(
      postJson("/console/api/providers/opencode-free/accounts", { name: "main", credential: "ocf-secret-token" }, { cookie })
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string; credentialHint: string };
    expect(createdBody.id.length).toBeGreaterThan(0);
    expect(createdBody.credentialHint).toBe("…oken"); // last 4 chars, masked

    const listed = await app.handle(authed("/console/api/providers/opencode-free/accounts", cookie));
    expect(listed.status).toBe(200);
    const items = ((await listed.json()) as { items: Record<string, unknown>[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.name).toBe("main");
    expect(items[0]!.credentialKind).toBe("bearer");
    expect(items[0]!.active).toBe(true);
    expect(JSON.stringify(items[0])).not.toContain("ocf-secret-token"); // never plaintext
    expect(items[0]!.credential_enc).toBeUndefined();

    const patched = await app.handle(
      postJson(`/console/api/providers/opencode-free/accounts/${createdBody.id}`, { name: "renamed", priority: 50, active: false }, { cookie })
    );
    expect(patched.status).toBe(200);
    const afterPatch = await app.handle(authed("/console/api/providers/opencode-free/accounts", cookie));
    const patchedItems = ((await afterPatch.json()) as { items: { name: string; priority: number; active: boolean }[] }).items;
    expect(patchedItems[0]!.name).toBe("renamed");
    expect(patchedItems[0]!.priority).toBe(50);
    expect(patchedItems[0]!.active).toBe(false); // inactive still listed

    const deleted = await app.handle(deleteJson(`/console/api/providers/opencode-free/accounts/${createdBody.id}`, cookie));
    expect(deleted.status).toBe(200);
    const afterDelete = await app.handle(authed("/console/api/providers/opencode-free/accounts", cookie));
    expect(((await afterDelete.json()) as { items: unknown[] }).items.length).toBe(0);
  });

  test("credential kind is enforced per provider", async () => {
    const cookie = await loginAndGetCookie();

    // qoder wants pat.
    const qd = await app.handle(
      postJson("/console/api/providers/qoder/accounts", { name: "qd", credential: "qd_pat_123456" }, { cookie })
    );
    expect(qd.status).toBe(201);
    expect(((await qd.json()) as { credentialHint: string }).credentialHint).toBe("…3456");

    const qdWrong = await app.handle(
      postJson("/console/api/providers/qoder/accounts", { name: "qd2", credentialKind: "bearer", credential: "x" }, { cookie })
    );
    expect(qdWrong.status).toBe(400);

    // devin wants session-token.
    const dv = await app.handle(
      postJson("/console/api/providers/devin/accounts", { name: "dv", credentialKind: "session-token", credential: "devin-session-abc" }, { cookie })
    );
    expect(dv.status).toBe(201);
    const dvWrong = await app.handle(
      postJson("/console/api/providers/devin/accounts", { name: "dv2", credentialKind: "pat", credential: "x" }, { cookie })
    );
    expect(dvWrong.status).toBe(400);
  });

  test("duplicate account name per provider → 409; same name on other provider ok", async () => {
    const cookie = await loginAndGetCookie();
    const first = await app.handle(
      postJson("/console/api/providers/kimchi/accounts", { name: "shared-name", credential: "kc-1" }, { cookie })
    );
    expect(first.status).toBe(201);
    const dup = await app.handle(
      postJson("/console/api/providers/kimchi/accounts", { name: "shared-name", credential: "kc-2" }, { cookie })
    );
    expect(dup.status).toBe(409);
    const otherProvider = await app.handle(
      postJson("/console/api/providers/commandcode/accounts", { name: "shared-name", credential: "cmd-1" }, { cookie })
    );
    expect(otherProvider.status).toBe(201);
  });

  test("missing name or credential → 400; unknown provider → 404", async () => {
    const cookie = await loginAndGetCookie();
    const noName = await app.handle(postJson("/console/api/providers/kimchi/accounts", { credential: "x" }, { cookie }));
    expect(noName.status).toBe(400);
    const noCred = await app.handle(postJson("/console/api/providers/kimchi/accounts", { name: "a" }, { cookie }));
    expect(noCred.status).toBe(400);
    const unknown = await app.handle(postJson("/console/api/providers/not-a-provider/accounts", { name: "a", credential: "x" }, { cookie }));
    expect(unknown.status).toBe(404);
  });

  test("patch with new credential replaces it; hint updates", async () => {
    const cookie = await loginAndGetCookie();
    const created = await app.handle(
      postJson("/console/api/providers/opencode-free/accounts", { name: "recred", credential: "first-value" }, { cookie })
    );
    const { id } = (await created.json()) as { id: string };

    const patched = await app.handle(
      postJson(`/console/api/providers/opencode-free/accounts/${id}`, { credential: "second-value-xyz" }, { cookie })
    );
    expect(patched.status).toBe(200);

    const row = getDb().query("SELECT credential, credential_hint FROM provider_accounts WHERE id = ?").get(id) as {
      credential: string;
      credential_hint: string;
    };
    expect(row.credential_hint).toBe("…-xyz");
    expect(row.credential).toBe("second-value-xyz");
  });

  test("proxyPoolId must reference an existing pool", async () => {
    const cookie = await loginAndGetCookie();
    const badPool = await app.handle(
      postJson("/console/api/providers/commandcode/accounts", { name: "bad-pool", credential: "x", proxyPoolId: "ghost" }, { cookie })
    );
    expect(badPool.status).toBe(400);

    const poolId = seedProxyPool("acct-pool");
    const goodPool = await app.handle(
      postJson("/console/api/providers/commandcode/accounts", { name: "good-pool", credential: "x", proxyPoolId: poolId }, { cookie })
    );
    expect(goodPool.status).toBe(201);

    const listed = await app.handle(authed("/console/api/providers/commandcode/accounts", cookie));
    const items = ((await listed.json()) as { items: { proxyPoolId: string | null }[] }).items;
    expect(items[0]!.proxyPoolId).toBe(poolId);
  });
});

describe("credential storage + model test", () => {
  test("stored credential is plaintext and readable as-is", async () => {
    const cookie = await loginAndGetCookie();
    const created = await app.handle(
      postJson("/console/api/providers/opencode-free/accounts", { name: "plain-check", credential: "super-secret-abc123" }, { cookie })
    );
    const { id } = (await created.json()) as { id: string };

    const row = getDb().query("SELECT credential, credential_hint FROM provider_accounts WHERE id = ?").get(id) as {
      credential: string;
      credential_hint: string;
    };
    expect(row.credential).toBe("super-secret-abc123");
    expect(row.credential_hint).toBe("…c123");
  });

  test("the credential endpoint reveals the secret only to an authenticated session", async () => {
    const cookie = await loginAndGetCookie();
    const created = await app.handle(
      postJson("/console/api/providers/opencode-free/accounts", { name: "copy-me", credential: "copy-this-value-4321" }, { cookie })
    );
    const { id } = (await created.json()) as { id: string };

    const revealed = await app.handle(authed(`/console/api/providers/opencode-free/accounts/${id}/credential`, cookie));
    expect(revealed.status).toBe(200);
    expect(((await revealed.json()) as { credential: string }).credential).toBe("copy-this-value-4321");

    // No session at all.
    const anonymous = await app.handle(new Request(`http://localhost/console/api/providers/opencode-free/accounts/${id}/credential`));
    expect(anonymous.status).toBe(401);

    // Right account id, wrong provider namespace.
    const crossProvider = await app.handle(authed(`/console/api/providers/kimchi/accounts/${id}/credential`, cookie));
    expect(crossProvider.status).toBe(404);

    const ghost = await app.handle(authed("/console/api/providers/opencode-free/accounts/ghost/credential", cookie));
    expect(ghost.status).toBe(404);
  });

  test("the API never echoes a stored credential back to the client", async () => {
    const cookie = await loginAndGetCookie();
    await app.handle(
      postJson("/console/api/providers/opencode-free/accounts", { name: "no-echo", credential: "leak-me-not-9999" }, { cookie })
    );

    const listed = await app.handle(authed("/console/api/providers/opencode-free/accounts", cookie));
    expect(listed.status).toBe(200);
    const raw = await listed.text();
    expect(raw).not.toContain("leak-me-not-9999");
    expect(raw).toContain("…9999");
  });

  test("model test endpoint validates inputs without touching upstream", async () => {
    const cookie = await loginAndGetCookie();
    // Mock both fetches: catalog + chat completion (ocf does two round-trips).
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "big-pickle" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "test-1",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const badProvider = await app.handle(postJson("/console/api/providers/nope/models/x/test", { mode: "manual", credential: "x" }, { cookie }));
    expect(badProvider.status).toBe(404);

    const badModel = await app.handle(postJson("/console/api/providers/opencode-free/models/ghost-model/test", { mode: "manual", credential: "x" }, { cookie }));
    expect(badModel.status).toBe(404);

    const badMode = await app.handle(
      postJson("/console/api/providers/opencode-free/models/big-pickle/test", { mode: "wat" }, { cookie })
    );
    expect(badMode.status).toBe(400);

    // Manual mode with no credential is allowed for free providers like ocf.
    const manualNoCred = await app.handle(
      postJson("/console/api/providers/opencode-free/models/big-pickle/test", { mode: "manual" }, { cookie })
    );
    expect(manualNoCred.status).toBe(200);
    const manualBody = (await manualNoCred.json()) as { ok: boolean; sample?: string };
    expect(manualBody.ok).toBe(true);
    expect(manualBody.sample).toBe("pong");

    const accountNoId = await app.handle(
      postJson("/console/api/providers/opencode-free/models/big-pickle/test", { mode: "account" }, { cookie })
    );
    expect(accountNoId.status).toBe(400);
  });

  test("model test 'auto' mode requires an account only when the provider actually needs a credential", async () => {
    const cookie = await loginAndGetCookie();

    // Kimchi requires a real bearer credential — with zero stored accounts,
    // auto mode has nothing to rotate through and must say so.
    const noAccountNeedsAuth = await app.handle(
      postJson("/console/api/providers/kimchi/models/kimi-k2.7/test", { mode: "auto" }, { cookie })
    );
    expect(noAccountNeedsAuth.status).toBe(400);

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "big-pickle" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    // opencode-free needs no credential at all, so a completely empty account
    // list is not a blocker — the console must be able to run this test
    // directly with nothing configured.
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "test-3",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const noAccountNoAuth = await app.handle(
      postJson("/console/api/providers/opencode-free/models/big-pickle/test", { mode: "auto" }, { cookie })
    );
    expect(noAccountNoAuth.status).toBe(200);
    const noAccountNoAuthBody = (await noAccountNoAuth.json()) as { ok: boolean };
    expect(noAccountNoAuthBody.ok).toBe(true);

    const created = await app.handle(
      postJson("/console/api/providers/opencode-free/accounts", { name: "rotator", credential: "ocf-secret" }, { cookie })
    );
    expect(created.status).toBe(201);

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "test-2",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    // With a stored account, auto mode picks it without an accountId in the request.
    const autoPicked = await app.handle(
      postJson("/console/api/providers/opencode-free/models/big-pickle/test", { mode: "auto" }, { cookie })
    );
    expect(autoPicked.status).toBe(200);
    const autoBody = (await autoPicked.json()) as { ok: boolean; sample?: string };
    expect(autoBody.ok).toBe(true);

    // opencode-free ignores the resolved credential (it always calls upstream
    // as "Bearer public") — the assertion that matters here is that auto mode
    // succeeded with zero accountId in the request body, i.e. it rotated on
    // its own instead of erroring for want of a manual selection.
    const upstreamCall = fetchSpy.mock.calls.at(-1)!;
    const upstreamHeaders = new Headers((upstreamCall[1] as RequestInit).headers);
    expect(upstreamHeaders.get("authorization")).toBe("Bearer public");
  });
});
