import { beforeEach, describe, expect, test } from "bun:test";
import { pickProxyTarget, resolveCredentialForDispatch } from "../../src/upstream/dispatch";
import { resolveQualifiedTarget } from "../../src/routing/resolve";
import { createProxy, rotateSmartProxyAssignment } from "../../src/console/db/repos/proxies";
import { patchProxyPoolSettings } from "../../src/console/db/repos/proxy-settings";
import { useIsolatedDataDir } from "../console/helpers";

describe("qualified dispatch fast paths", () => {
  beforeEach(() => {
    useIsolatedDataDir();
  });

  test("returns an auth-free credential without consulting account routing", async () => {
    const credential = await resolveCredentialForDispatch("opencode-free", {});
    expect(credential).toEqual({ kind: "none", value: "" });
  });

  test("resolves a direct qualified model without combo expansion", async () => {
    const result = await resolveQualifiedTarget("kimchi/kimi-k2.7");
    expect(result).toMatchObject({
      legacy: false,
      target: { provider: "kimchi", modelId: "kimi-k2.7" },
    });
  });
});

describe("pickProxyTarget - outbound proxy pool selection", () => {
  beforeEach(() => {
    useIsolatedDataDir();
  });

  test("returns null (direct connection) when the pool is disabled, the product default", () => {
    createProxy({ name: "p1", protocol: "socks5", host: "10.0.0.1", port: 1080 });
    expect(pickProxyTarget("openai")).toBeNull();
  });

  test("returns a proxy target for an eligible provider once the pool is enabled", () => {
    const created = createProxy({ name: "p1", protocol: "socks5", host: "10.0.0.1", port: 1080, username: "u", password: "p" });
    patchProxyPoolSettings({ enabled: true });
    const target = pickProxyTarget("openai");
    expect(target).toEqual({ id: created.id, name: "p1", protocol: "socks5", isRelay: false, host: "10.0.0.1", port: 1080, username: "u", password: "p" });
  });

  test("returns relay metadata for the selected relay proxy", () => {
    createProxy({ name: "relay", protocol: "https", host: "relay.example", port: 443, isRelay: true });
    patchProxyPoolSettings({ enabled: true });
    expect(pickProxyTarget("openai")).toMatchObject({ isRelay: true, protocol: "https" });
  });

  test("returns null for a provider in the exclusion list even when the pool is enabled", () => {
    createProxy({ name: "p1", protocol: "http", host: "10.0.0.1", port: 8080 });
    patchProxyPoolSettings({ enabled: true, excludedProviders: ["openai"] });
    expect(pickProxyTarget("openai")).toBeNull();
    expect(pickProxyTarget("anthropic")).not.toBeNull();
  });

  test("sticks each client to a distinct proxy before rotating when the pool is full", () => {
    const first = createProxy({ name: "p1", protocol: "http", host: "10.0.0.1", port: 8080 });
    const second = createProxy({ name: "p2", protocol: "http", host: "10.0.0.2", port: 8080 });
    patchProxyPoolSettings({ enabled: true, smartDynamicRouting: true });

    const clientOne = pickProxyTarget("openai", "192.0.2.1", 1);
    const clientTwo = pickProxyTarget("openai", "192.0.2.2", 1);
    const clientOneAgain = pickProxyTarget("openai", "192.0.2.1", 1);
    const clientThree = pickProxyTarget("openai", "192.0.2.3", 1);

    const clientOneId = clientOne?.id ?? "";
    const clientTwoId = clientTwo?.id ?? "";
    const clientOneAgainId = clientOneAgain?.id ?? "";
    const clientThreeId = clientThree?.id ?? "";
    expect([first.id, second.id]).toContain(clientOneId);
    expect([first.id, second.id]).toContain(clientTwoId);
    expect(clientOneId).not.toBe(clientTwoId);
    expect(clientOneAgainId).toBe(clientOneId);
    expect([first.id, second.id]).toContain(clientThreeId);
  });

  test("moves to a fresh sticky proxy set after the assigned set is rate-limited", () => {
    const first = createProxy({ name: "p1", protocol: "http", host: "10.0.0.1", port: 8080 });
    const second = createProxy({ name: "p2", protocol: "http", host: "10.0.0.2", port: 8080 });
    const third = createProxy({ name: "p3", protocol: "http", host: "10.0.0.3", port: 8080 });
    patchProxyPoolSettings({ enabled: true, smartDynamicRouting: true, smartDynamicProxyCount: 2 });

    const initial = pickProxyTarget("openai", "192.0.2.9");
    rotateSmartProxyAssignment("192.0.2.9");
    const secondSticky = pickProxyTarget("openai", "192.0.2.9");
    rotateSmartProxyAssignment("192.0.2.9");
    const dynamic = pickProxyTarget("openai", "192.0.2.9");

    const initialId = initial?.id ?? "";
    const secondStickyId = secondSticky?.id ?? "";
    const dynamicId = dynamic?.id ?? "";
    expect([first.id, second.id, third.id]).toContain(initialId);
    expect([first.id, second.id, third.id]).toContain(secondStickyId);
    expect(dynamicId).toBe(third.id);
  });

  test("returns null when the pool is enabled but has no active proxies", () => {
    patchProxyPoolSettings({ enabled: true });
    expect(pickProxyTarget("openai")).toBeNull();
  });
});
