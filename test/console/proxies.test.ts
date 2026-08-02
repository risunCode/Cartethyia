/** Outbound proxy pool console API - CRUD, global routing settings, tester. */

import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { app } from "../../src/app";
import { testProxyTarget } from "../../src/console/api/proxies";
import { createProxy, getProxy, markProxyRateLimited, parseProxyUrl, pickProxyForRotation, resetProxyRoutingForTests } from "../../src/console/db/repos/proxies";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";

afterEach(() => useIsolatedDataDir());

describe("proxies CRUD", () => {
  test("creates, lists, patches, reveals credential, and deletes a proxy", async () => {
    useIsolatedDataDir();
    const cookie = await loginAndGetCookie();

    const create = await app.handle(postJson("/console/api/proxies", { name: "eu-1", protocol: "socks5", host: "10.0.0.1", port: 1080, username: "u", password: "p" }, { cookie }));
    expect(create.status).toBe(201);
    const created = await create.json() as { id: string; passwordHint: string | null };
    expect(created.passwordHint).toBe("…p");

    const list = await app.handle(new Request("http://localhost/console/api/proxies", { headers: { cookie } }));
    const listBody = await list.json() as { items: Array<{ id: string; name: string; active: boolean }> };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]!.name).toBe("eu-1");
    expect(listBody.items[0]!.active).toBe(true);

    const patch = await app.handle(postJson(`/console/api/proxies/${created.id}`, { priority: 50, active: false }, { cookie }));
    expect(patch.status).toBe(200);
    const listAfterPatch = await app.handle(new Request("http://localhost/console/api/proxies", { headers: { cookie } }));
    const patchedItems = (await listAfterPatch.json() as { items: Array<{ active: boolean; priority: number }> }).items;
    expect(patchedItems[0]!.active).toBe(false);
    expect(patchedItems[0]!.priority).toBe(50);

    const credential = await app.handle(new Request(`http://localhost/console/api/proxies/${created.id}/credential`, { headers: { cookie } }));
    expect(credential.status).toBe(200);
    expect(await credential.json()).toEqual({ username: "u", password: "p" });

    const del = await app.handle(new Request(`http://localhost/console/api/proxies/${created.id}`, { method: "DELETE", headers: { "content-type": "application/json", cookie } }));
    expect(del.status).toBe(200);
    const listAfterDelete = await app.handle(new Request("http://localhost/console/api/proxies", { headers: { cookie } }));
    expect((await listAfterDelete.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  test("disables a rate-limited proxy for one hour and rotates to the next active proxy", () => {
    useIsolatedDataDir();
    const first = createProxy({ name: "priority-1", protocol: "http", host: "10.0.0.1", port: 8080, priority: 10 });
    const second = createProxy({ name: "priority-2", protocol: "http", host: "10.0.0.2", port: 8080, priority: 20 });
    resetProxyRoutingForTests();

    expect(pickProxyForRotation()).toMatchObject({ id: first.id });
    markProxyRateLimited(first.id);

    const cooled = getProxy(first.id);
    expect(cooled).not.toBeNull();
    expect(Date.parse(cooled!.cooldown_until ?? "") - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(pickProxyForRotation()?.id).toBe(second.id);
  });

  test("excludes manually disabled proxies from rotation", () => {
    useIsolatedDataDir();
    const disabled = createProxy({ name: "disabled", protocol: "http", host: "10.0.0.1", port: 8080, priority: 10, active: false });
    const enabled = createProxy({ name: "enabled", protocol: "http", host: "10.0.0.2", port: 8080, priority: 20 });
    resetProxyRoutingForTests();

    expect(pickProxyForRotation()?.id).toBe(enabled.id);
    expect(pickProxyForRotation()?.id).not.toBe(disabled.id);
  });

  test("parses authenticated and passwordless proxy URLs", () => {
    expect(parseProxyUrl("https://user:p%40ss@example.com:8443")).toEqual({ protocol: "https", host: "example.com", port: 8443, username: "user", password: "p@ss" });
    expect(parseProxyUrl("https://relay.example.vercel.app")).toEqual({ protocol: "https", host: "relay.example.vercel.app", port: 443, username: null, password: null });
    expect(parseProxyUrl("socks5://example.com:1080")).toEqual({ protocol: "socks5", host: "example.com", port: 1080, username: null, password: null });
    expect(parseProxyUrl("ftp://example.com:21")).toBeNull();
  });

  test("creates a batch of auto-detected proxies with generated names", async () => {
    useIsolatedDataDir();
    const cookie = await loginAndGetCookie();
    const response = await app.handle(postJson("/console/api/proxies/batch", {
      entries: ["http://one.example:8080", "socks5://user:pass@two.example:1080", "invalid"],
    }, { cookie }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ created: 2, skipped: [{ line: 3, reason: "invalid proxy URL (need http://, https:// or socks5://host:port)" }] });

    const list = await app.handle(new Request("http://localhost/console/api/proxies?limit=100", { headers: { cookie } }));
    const items = (await list.json() as { items: Array<{ name: string; protocol: string; username: string | null; active: boolean }> }).items;
    expect(items.map((item) => item.name)).toEqual(["one", "two"]);
    expect(items.map((item) => item.protocol)).toEqual(["http", "socks5"]);
    expect(items[1]!.username).toBe("user");
    expect(items.every((item) => item.active)).toBe(true);
  });

  test("imports passwordless Vercel URLs without explicit ports", async () => {
    useIsolatedDataDir();
    const cookie = await loginAndGetCookie();
    const response = await app.handle(postJson("/console/api/proxies/batch", {
      entries: [
        "https://akunyt-sg1-qv31wj29k-buwok-akunyt.vercel.app",
        "https://rico-hk1-p2men9joe-rico14ntact.vercel.app",
      ],
    }, { cookie }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ created: 2, skipped: [] });
    const list = await app.handle(new Request("http://localhost/console/api/proxies?limit=100", { headers: { cookie } }));
    const items = (await list.json() as { items: Array<{ port: number; isRelay: boolean; active: boolean }> }).items;
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.port === 443 && item.isRelay && item.active)).toBe(true);
  });

  test("detects multiple Vercel relays automatically from their domains", async () => {
    useIsolatedDataDir();
    const cookie = await loginAndGetCookie();
    const first = await app.handle(postJson("/console/api/proxies", { name: "relay-1", protocol: "https", host: "akunbsi-syd2-a7bz9qa01-15220795-9387s-projects.vercel.app", port: 443 }, { cookie }));
    const second = await app.handle(postJson("/console/api/proxies", { name: "relay-2", protocol: "https", host: "akunyt-sg2-9otsvio6g-buwok-akunyt.vercel.app", port: 443 }, { cookie }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const list = await app.handle(new Request("http://localhost/console/api/proxies?limit=100", { headers: { cookie } }));
    const items = (await list.json() as { items: Array<{ isRelay: boolean }> }).items;
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.isRelay)).toBe(true);

    const invalid = await app.handle(postJson("/console/api/proxies", { name: "bad-relay", protocol: "socks5", host: "akunbsi-syd2.vercel.app", port: 1080 }, { cookie }));
    expect(invalid.status).toBe(400);
  });

  test("rejects invalid protocol and out-of-range port", async () => {
    useIsolatedDataDir();
    const cookie = await loginAndGetCookie();

    const badProtocol = await app.handle(postJson("/console/api/proxies", { name: "x", protocol: "ftp", host: "h", port: 80 }, { cookie }));
    expect(badProtocol.status).toBe(400);

    const badPort = await app.handle(postJson("/console/api/proxies", { name: "x", protocol: "http", host: "h", port: 99999 }, { cookie }));
    expect(badPort.status).toBe(400);
  });

  test("404s for an unknown proxy id on patch/delete/credential", async () => {
    useIsolatedDataDir();
    const cookie = await loginAndGetCookie();

    expect((await app.handle(postJson("/console/api/proxies/ghost", { priority: 1 }, { cookie }))).status).toBe(404);
    expect((await app.handle(new Request("http://localhost/console/api/proxies/ghost", { method: "DELETE", headers: { "content-type": "application/json", cookie } }))).status).toBe(404);
    expect((await app.handle(new Request("http://localhost/console/api/proxies/ghost/credential", { headers: { cookie } }))).status).toBe(404);
  });
});

describe("proxy pool settings", () => {
  test("defaults to disabled/direct and persists a valid patch", async () => {
    useIsolatedDataDir();
    const cookie = await loginAndGetCookie();

    const initial = await app.handle(new Request("http://localhost/console/api/proxy-settings", { headers: { cookie } }));
    expect(await initial.json()).toMatchObject({ enabled: false, excludedProviders: [] });

    const patch = await app.handle(postJson("/console/api/proxy-settings", { enabled: true, excludedProviders: ["openai", "anthropic"] }, { cookie }));
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ enabled: true, excludedProviders: ["openai", "anthropic"] });
  });

  test("rejects an unknown provider id in excludedProviders", async () => {
    useIsolatedDataDir();
    const cookie = await loginAndGetCookie();
    const res = await app.handle(postJson("/console/api/proxy-settings", { excludedProviders: ["not-a-real-provider"] }, { cookie }));
    expect(res.status).toBe(400);
  });
});

describe("proxy connection tester", () => {
  test("reports success and latency through a live local SOCKS5 tunnel to a local canary", async () => {
    // Deterministic + offline: both the SOCKS5 proxy AND the canary target
    // are local servers spun up in-process, so this exercises the exact
    // tunnel-then-fetch code path `testProxyTarget` uses in production
    // without depending on real internet egress being available in CI.
    const canary = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 204 }) });
    const socksServer = net.createServer((client) => {
      client.once("data", () => {
        client.write(Buffer.from([0x05, 0x00]));
        client.once("data", (raw) => {
          const req = raw as Buffer;
          const atyp = req[3]!;
          let addr: string; let offset: number;
          if (atyp === 0x03) { const len = req[4]!; addr = req.subarray(5, 5 + len).toString(); offset = 5 + len; }
          else { addr = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`; offset = 8; }
          const port = req.readUInt16BE(offset);
          const upstream = net.connect(port, addr, () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            upstream.pipe(client);
            client.pipe(upstream);
          });
          upstream.on("error", () => client.end());
        });
      });
      client.on("error", () => {});
    });
    await new Promise<void>((resolve) => socksServer.listen(0, "127.0.0.1", resolve));
    const port = (socksServer.address() as net.AddressInfo).port;

    try {
      const result = await testProxyTarget(
        { id: "adhoc", protocol: "socks5", host: "127.0.0.1", port },
        `http://127.0.0.1:${canary.port}/generate_204`,
      );
      expect(result.ok).toBe(true);
      expect(result.ok && result.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      socksServer.close();
      canary.stop(true);
    }
  });

  test("reports success through a local relay forwarding endpoint", async () => {
    const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => new Response(request.headers.get("x-relay-marker") === null ? "ok" : "leaked", { status: 204 }) });
    const relay = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const origin = request.headers.get("x-relay-target");
        const path = request.headers.get("x-relay-path");
        if (!origin || !path) return new Response("missing relay headers", { status: 400 });
        const headers = new Headers(request.headers);
        headers.delete("x-relay-target");
        headers.delete("x-relay-path");
        const upstream = await fetch(`${origin}${path}`, { method: request.method, headers });
        return new Response(null, { status: upstream.status });
      },
    });
    const relayPort = relay.port;
    const targetPort = target.port;
    if (relayPort === undefined || targetPort === undefined) throw new Error("local relay servers did not expose ports");
    try {
      const result = await testProxyTarget({ id: "relay", protocol: "http", isRelay: true, host: "127.0.0.1", port: relayPort }, `http://127.0.0.1:${targetPort}/generate_204`);
      expect(result.ok).toBe(true);
    } finally {
      relay.stop(true);
      target.stop(true);
    }
  });

  test("reports failure for an unreachable proxy", async () => {
    useIsolatedDataDir();
    const cookie = await loginAndGetCookie();
    const res = await app.handle(postJson("/console/api/proxies/test", { protocol: "socks5", host: "127.0.0.1", port: 1 }, { cookie }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBeString();
  });

  test("404s testing a saved proxy id that doesn't exist", async () => {
    useIsolatedDataDir();
    const cookie = await loginAndGetCookie();
    const res = await app.handle(postJson("/console/api/proxies/ghost/test", {}, { cookie }));
    expect(res.status).toBe(404);
  });
});
