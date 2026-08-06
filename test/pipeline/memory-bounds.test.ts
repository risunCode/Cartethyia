import { describe, expect, test } from "bun:test";
import { normalizeStudioMessages } from "../../src/console/model-studio";
import { readBoundedJson } from "../../src/domain/protocols";
import { createRouteSnapshotCache } from "../../src/app/routing-snapshot";
import { MemoryRouteTransitionStore } from "../../src/console/services";
import { createConsoleLogStreamHub } from "../../src/console/streams";

describe("runtime memory bounds", () => {
  test("rejects request bodies after the byte cap before parsing", async () => {
    const result = await readBoundedJson(new Request("http://localhost", { method: "POST", body: JSON.stringify({ payload: "1234567890" }) }), 8);
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  test("parses a valid body when content length is unavailable", async () => {
    const result = await readBoundedJson(new Request("http://localhost", { method: "POST", body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":true}')); controller.close(); } }) }), 128);
    expect(result).toEqual({ ok: true, value: { ok: true } });
  });

  test("normalizes oversized Model Studio message fields", () => {
    const message = normalizeStudioMessages([{ role: "user", content: "x".repeat(200_000), ts: "now", reasoning: "y".repeat(200_000) }]);
    expect(message).not.toBeNull();
    expect(message?.[0]?.content.length).toBeLessThan(200_000);
    expect(message?.[0]?.reasoning?.length).toBeLessThan(200_000);
  });

  test("reuses route snapshots until the routing revision changes", async () => {
    let revision = 0;
    const aliases = [{ alias: "short", model: "long" }];
    const config = {
      aliases: { list: () => aliases },
      combos: { list: () => [] },
      accounts: { list: () => [] },
      stores: { proxyPool: { listProxies: async () => [] } },
    } as never;
    const registry = { list: () => [{ metadata: { id: "openai" }, models: { list: [] } }] } as never;
    const cache = createRouteSnapshotCache({ config, registry, readRevision: () => revision });

    const first = await cache.get();
    expect(await cache.get()).toBe(first);
    revision = 1;
    aliases.push({ alias: "new", model: "target" });
    const rebuilt = await cache.get();
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.aliases.get("new")).toBe("target");
  });

  test("evicts the least-recent route transition at the global cap", async () => {
    const store = new MemoryRouteTransitionStore({ maxRouteTransitionRoutes: 2, maxRouteTransitionsPerRoute: 2 });
    const event = (routeId: string) => ({ scope: "account" as const, previousRouteId: null, replacementRouteId: routeId, reason: "test", occurredAt: new Date().toISOString() });
    await store.record("account", "first", event("first"));
    await store.record("account", "second", event("second"));
    await store.record("account", "third", event("third"));
    expect(await store.latest("account", "first")).toBeNull();
    expect((await store.latest("account", "third"))?.replacementRouteId).toBe("third");
  });

  test("detaches console log streams without retaining clients", async () => {
    const row = { id: 1, ts: new Date().toISOString(), level: "info", scope: "test", msg: "hello" };
    const hub = createConsoleLogStreamHub({ latest: () => [row], after: () => [] });
    const response = hub.handle(new Request("http://localhost/console-logs/stream"));
    expect(hub.activeClients).toBe(1);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const initial = await reader?.read();
    expect(new TextDecoder().decode(initial?.value)).toContain('event: init');
    await reader?.cancel();
    expect(hub.activeClients).toBe(0);
    hub.close();
  });
});
