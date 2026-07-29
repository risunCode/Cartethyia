/** Access rules tests — CRUD, ACL enforcement for console + proxy scopes (REQ-15). */

import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../../src/app";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";

function authed(path: string, cookie: string): Request {
  return new Request(`http://localhost${path}`, { headers: { cookie } });
}

function postChat(body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  useIsolatedDataDir();
});

describe("access rules CRUD", () => {
  test("GET returns default open rules for both scopes", async () => {
    const cookie = await loginAndGetCookie();

    const res = await app.handle(authed("/console/api/access", cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      proxy: { scope: string; mode: string; entries: string[] };
      console: { scope: string; mode: string; entries: string[] };
    };
    expect(body.proxy.mode).toBe("open");
    expect(body.console.mode).toBe("open");
    expect(body.proxy.entries).toEqual([]);
    expect(body.console.entries).toEqual([]);
  });

  test("set console scope to allowlist with CIDR entries", async () => {
    const cookie = await loginAndGetCookie();

    const res = await app.handle(
      postJson("/console/api/access/console", { mode: "allowlist", entries: ["192.168.1.0/24", "10.0.0.1"] }, { cookie })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scope: string; mode: string; entries: string[] };
    expect(body.scope).toBe("console");
    expect(body.mode).toBe("allowlist");
    expect(body.entries).toEqual(["192.168.1.0/24", "10.0.0.1"]);
  });

  test("set proxy scope to denylist", async () => {
    const cookie = await loginAndGetCookie();

    const res = await app.handle(
      postJson("/console/api/access/proxy", { mode: "denylist", entries: ["192.168.1.100"] }, { cookie })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scope: string; mode: string; entries: string[] };
    expect(body.scope).toBe("proxy");
    expect(body.mode).toBe("denylist");
    expect(body.entries).toEqual(["192.168.1.100"]);
  });

  test("validation: scope must be proxy or console", async () => {
    const cookie = await loginAndGetCookie();

    const badScope = await app.handle(postJson("/console/api/access/unknown", { mode: "open" }, { cookie }));
    expect(badScope.status).toBe(400);
  });

  test("validation: invalid CIDR entry rejected", async () => {
    const cookie = await loginAndGetCookie();

    const badEntry = await app.handle(postJson("/console/api/access/console", { mode: "allowlist", entries: ["999.999.999.999/99"] }, { cookie }));
    expect(badEntry.status).toBe(400);
    const body = (await badEntry.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain("invalid entry");
  });

  test("validation: invalid mode rejected", async () => {
    const cookie = await loginAndGetCookie();

    const badMode = await app.handle(postJson("/console/api/access/console", { mode: "invalid" }, { cookie }));
    expect(badMode.status).toBe(400);
  });

  test("setting open mode clears entries", async () => {
    const cookie = await loginAndGetCookie();

    // Use denylist mode (not allowlist) so our subsequent request from 127.0.0.1 isn't blocked.
    await app.handle(postJson("/console/api/access/console", { mode: "denylist", entries: ["192.168.1.1"] }, { cookie }));
    const setOpen = await app.handle(postJson("/console/api/access/console", { mode: "open" }, { cookie }));
    expect(setOpen.status).toBe(200);
    const body = (await setOpen.json()) as { entries: string[] };
    expect(body.entries).toEqual([]);
  });
});

describe("console ACL enforcement", () => {
  test("denylist console scope blocks login from denied IP", async () => {
    const cookie = await loginAndGetCookie();

    // Set console denylist to block 127.0.0.1 (the IP used by test requests)
    await app.handle(postJson("/console/api/access/console", { mode: "denylist", entries: ["127.0.0.1"] }, { cookie }));

    // Login request should now be blocked by ACL
    const loginRes = await app.handle(postJson("/console/api/login", { password: "carte1234" }));
    expect(loginRes.status).toBe(403);
    const body = (await loginRes.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain("IP");
  });

  test("allowlist console scope blocks login when IP not in list", async () => {
    const cookie = await loginAndGetCookie();

    await app.handle(postJson("/console/api/access/console", { mode: "allowlist", entries: ["192.168.1.0/24"] }, { cookie }));

    const loginRes = await app.handle(postJson("/console/api/login", { password: "carte1234" }));
    expect(loginRes.status).toBe(403);
  });

  test("allowlist console scope allows login when IP is in list", async () => {
    const cookie = await loginAndGetCookie();

    await app.handle(postJson("/console/api/access/console", { mode: "allowlist", entries: ["127.0.0.1"] }, { cookie }));

    const loginRes = await app.handle(postJson("/console/api/login", { password: "carte1234" }));
    expect(loginRes.status).toBe(200);
  });
});

describe("proxy ACL enforcement", () => {
  test("allowlist proxy scope blocks requests with unknown IP when IP not listed", async () => {
    const cookie = await loginAndGetCookie();

    // Set proxy allowlist to allow only a specific external IP
    await app.handle(postJson("/console/api/access/proxy", { mode: "allowlist", entries: ["10.0.0.1"] }, { cookie }));

    // Test request has no x-real-ip header → resolves to "unknown" → not in allowlist
    const res = await postChat({ model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toContain("IP");
  });

  test("denylist proxy scope allows requests when IP not in denylist", async () => {
    const cookie = await loginAndGetCookie();

    await app.handle(postJson("/console/api/access/proxy", { mode: "denylist", entries: ["10.0.0.1"] }, { cookie }));

    // Test request IP is "unknown" (no x-real-ip header), which is NOT in denylist → allowed
    // (The request will still fail with 401 for missing credential if proxy_auth_mode=api_key,
    //  but in default "open" mode it passes through ACL and hits the upstream mock.)
    const fetchSpy = (await import("bun:test")).spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "test", object: "chat.completion", created: 1234, model: "kimi-k2.7",
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    try {
      const res = await postChat(
        { model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }] },
        { authorization: "Bearer test_key" }
      );
      expect(res.status).toBe(200);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
