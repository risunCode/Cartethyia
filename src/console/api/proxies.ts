/**
 * Outbound proxy pool API - CRUD, global routing settings, and a connection
 * tester. Mirrors `provider-accounts.ts`'s shape (cursor pagination, masked
 * password, audited credential reveal) since it's the same kind of secret-
 * bearing pool, just scoped globally instead of per-provider.
 */

import { Elysia, t } from "elysia";
import { consoleError } from "../errors";
import { addAuditEvent } from "../db/repos/audit";
import { isProviderId } from "../../routing/providerMeta";
import {
  proxiesVersion,
  listProxies,
  listProxiesPage,
  getProxy,
  createProxy,
  patchProxy,
  deleteProxy,
  parseProxyImportText,
  isProxyRelayHost,
  proxyNamePrefix,
} from "../db/repos/proxies";
import { getProxyPoolSettings, patchProxyPoolSettings } from "../db/repos/proxy-settings";
import { buildProxyFetcher } from "../../upstream/proxy/adapter";
import type { ProxyProtocol, ProxyTarget } from "../../upstream/proxy/types";

const PROXY_PROTOCOLS: readonly ProxyProtocol[] = ["http", "https", "socks5"];

function isProxyProtocol(value: unknown): value is ProxyProtocol {
  return typeof value === "string" && (PROXY_PROTOCOLS as readonly string[]).includes(value);
}

/**
 * Cheap connectivity probe through a candidate proxy - a 204-no-body
 * connectivity-check endpoint (the same convention Android/ChromeOS use),
 * so the round trip measures the tunnel's real handshake + first-byte
 * latency without pulling any meaningful payload through it.
 */
export const DEFAULT_CANARY_URL = "https://www.google.com/generate_204";

export async function testProxyTarget(target: ProxyTarget, canaryUrl: string = DEFAULT_CANARY_URL): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const started = performance.now();
  try {
    const fetcher = buildProxyFetcher(target);
    const response = await fetcher(canaryUrl, { method: "GET", signal: AbortSignal.timeout(10_000) });
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok && response.status !== 204) {
      return { ok: false, error: `Canary request returned HTTP ${response.status}` };
    }
    return { ok: true, latencyMs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Connection failed" };
  }
}

export const proxiesRoutes = new Elysia({ prefix: "/console/api" })
  .get("/proxies", ({ query }) => {
    const version = proxiesVersion();
    if (query.since === version) return { unchanged: true, version };
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const page = listProxiesPage(Number.isFinite(limit) ? limit : 50, query.cursor);
    return { items: page.items, nextCursor: page.nextCursor, version: page.version };
  })
  /** Reveals one proxy's password - separate endpoint, audited, same pattern as account credential reveal. */
  .get("/proxies/:id/credential", ({ params, set }) => {
    const proxy = getProxy(params.id);
    if (!proxy) {
      set.status = 404;
      return consoleError("not_found", "proxy not found");
    }
    addAuditEvent("proxy.credential_revealed", { id: proxy.id, name: proxy.name });
    return { username: proxy.username, password: proxy.password };
  })
  .post("/proxies", ({ body, set }) => {
    const input = body as { name?: string; protocol?: string; isRelay?: boolean; host?: string; port?: number; username?: string | null; password?: string | null; priority?: number; active?: boolean };
    if (!input.name || typeof input.name !== "string" || input.name.trim().length === 0) {
      set.status = 400;
      return consoleError("invalid_request", "name is required");
    }
    if (!isProxyProtocol(input.protocol)) {
      set.status = 400;
      return consoleError("invalid_request", "protocol must be 'http', 'https', or 'socks5'");
    }
    if (!input.host || typeof input.host !== "string" || input.host.trim().length === 0) {
      set.status = 400;
      return consoleError("invalid_request", "host is required");
    }
    if ((input.isRelay === true || isProxyRelayHost(input.host.trim())) && input.protocol === "socks5") {
      set.status = 400;
      return consoleError("invalid_request", "Vercel/Cloudflare relay must use HTTP or HTTPS");
    }
    if (!Number.isInteger(input.port) || (input.port as number) < 1 || (input.port as number) > 65535) {
      set.status = 400;
      return consoleError("invalid_request", "port must be an integer between 1 and 65535");
    }
    try {
      const created = createProxy({
        name: input.name.trim(),
        protocol: input.protocol,
        isRelay: input.isRelay,
        host: input.host.trim(),
        port: input.port as number,
        username: input.username ?? null,
        password: input.password ?? null,
        priority: input.priority,
        active: input.active,
      });
      addAuditEvent("proxy.created", { id: created.id, name: input.name.trim(), protocol: input.protocol });
      set.status = 201;
      return created;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set.status = 500;
      return consoleError("internal", message);
    }
  })
  .post("/proxies/batch", ({ body, set }) => {
    const input = body as { namePrefix?: string; entries?: unknown };
    if (!Array.isArray(input.entries) || input.entries.length === 0 || input.entries.length > 500 || !input.entries.every((entry) => typeof entry === "string")) {
      set.status = 400;
      return consoleError("invalid_request", "entries must contain between 1 and 500 proxy URLs");
    }
    const parsed = parseProxyImportText(input.entries.join("\n"));
    const taken = new Set(listProxies().map((proxy) => proxy.name));
    const nextName = (prefix: string, numbered: boolean): string => {
      let candidate = numbered ? `${prefix}1` : prefix;
      let suffix = 2;
      while (taken.has(candidate)) {
        candidate = numbered ? `${prefix}${suffix}` : `${prefix}-${suffix}`;
        suffix += 1;
      }
      taken.add(candidate);
      return candidate;
    };
    const requestedPrefix = typeof input.namePrefix === "string" && input.namePrefix.trim() ? input.namePrefix.trim() : null;
    const created = parsed.added.map((proxy) => createProxy({ ...proxy, name: nextName(requestedPrefix ?? proxyNamePrefix(proxy.host), requestedPrefix !== null), active: true }));
    if (created.length > 0) addAuditEvent("proxy.batch_created", { count: created.length });
    set.status = 201;
    return { created: created.length, skipped: parsed.skipped };
  })
  .post("/proxies/:id", ({ params, body, set }) => {
    const proxy = getProxy(params.id);
    if (!proxy) {
      set.status = 404;
      return consoleError("not_found", "proxy not found");
    }
    const input = body as { name?: string; protocol?: string; isRelay?: boolean; host?: string; port?: number; username?: string | null; password?: string | null; priority?: number; active?: boolean };
    if (input.name !== undefined && (typeof input.name !== "string" || input.name.trim().length === 0)) {
      set.status = 400;
      return consoleError("invalid_request", "name must be a non-empty string");
    }
    if (input.protocol !== undefined && !isProxyProtocol(input.protocol)) {
      set.status = 400;
      return consoleError("invalid_request", "protocol must be 'http', 'https', or 'socks5'");
    }
    const relayByHost = input.host !== undefined ? isProxyRelayHost(input.host.trim()) : Boolean(proxy.is_relay);
    if ((input.isRelay === true || relayByHost) && (input.protocol ?? proxy.protocol) === "socks5") {
      set.status = 400;
      return consoleError("invalid_request", "Vercel/Cloudflare relay must use HTTP or HTTPS");
    }
    if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
      set.status = 400;
      return consoleError("invalid_request", "port must be an integer between 1 and 65535");
    }
    if (input.priority !== undefined && (!Number.isFinite(input.priority) || input.priority < 0 || input.priority > 1000)) {
      set.status = 400;
      return consoleError("invalid_request", "priority must be between 0 and 1000");
    }
    try {
      patchProxy(params.id, {
        name: input.name?.trim(),
        protocol: input.protocol as ProxyProtocol | undefined,
        isRelay: input.isRelay,
        host: input.host?.trim(),
        port: input.port,
        username: input.username,
        password: input.password,
        priority: input.priority,
        active: input.active,
      });
      addAuditEvent("proxy.patched", { id: params.id });
      return { ok: true };
    } catch (err) {
      set.status = 500;
      return consoleError("internal", err instanceof Error ? err.message : String(err));
    }
  })
  .delete("/proxies/:id", ({ params, set }) => {
    const removed = deleteProxy(params.id);
    if (!removed) {
      set.status = 404;
      return consoleError("not_found", "proxy not found");
    }
    addAuditEvent("proxy.deleted", { id: params.id });
    return { ok: true };
  })
  /** Tests a saved proxy's live connectivity + latency (Tester module). */
  .post("/proxies/:id/test", async ({ params, set }) => {
    const proxy = getProxy(params.id);
    if (!proxy) {
      set.status = 404;
      return consoleError("not_found", "proxy not found");
    }
    return testProxyTarget({ id: proxy.id, protocol: proxy.protocol as ProxyProtocol, isRelay: Boolean(proxy.is_relay), host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password });
  })
  /** Tests an ad-hoc, not-yet-saved proxy config - used by the "Add proxy" form before committing. */
  .post(
    "/proxies/test",
    async ({ body, set }) => {
      const input = body as { protocol?: string; isRelay?: boolean; host?: string; port?: number; username?: string | null; password?: string | null };
      if (!isProxyProtocol(input.protocol) || !input.host || !Number.isInteger(input.port)) {
        set.status = 400;
        return consoleError("invalid_request", "protocol, host, and port are required");
      }
      if ((input.isRelay === true || isProxyRelayHost(input.host)) && input.protocol === "socks5") {
        set.status = 400;
        return consoleError("invalid_request", "Vercel/Cloudflare relay must use HTTP or HTTPS");
      }
      return testProxyTarget({ id: "adhoc", protocol: input.protocol, isRelay: input.isRelay, host: input.host, port: input.port as number, username: input.username ?? null, password: input.password ?? null });
    },
    { body: t.Object({ protocol: t.String(), isRelay: t.Optional(t.Boolean()), host: t.String(), port: t.Number(), username: t.Optional(t.Union([t.String(), t.Null()])), password: t.Optional(t.Union([t.String(), t.Null()])) }) },
  )
  // ── Global routing settings (Proxy & Strategy) ──────────────────────────
  .get("/proxy-settings", () => getProxyPoolSettings())
  .post("/proxy-settings", ({ body, set }) => {
    const input = body as { enabled?: boolean; excludedProviders?: string[]; smartDynamicRouting?: boolean; smartDynamicProxyCount?: number };
    if (input.excludedProviders !== undefined) {
      if (!Array.isArray(input.excludedProviders) || !input.excludedProviders.every((id) => typeof id === "string" && isProviderId(id))) {
        set.status = 400;
        return consoleError("invalid_request", "excludedProviders must be an array of known provider ids");
      }
    }
    if (input.smartDynamicProxyCount !== undefined && (!Number.isFinite(input.smartDynamicProxyCount) || input.smartDynamicProxyCount < 1 || input.smartDynamicProxyCount > 10)) {
      set.status = 400;
      return consoleError("invalid_request", "smartDynamicProxyCount must be between 1 and 10");
    }
    const next = patchProxyPoolSettings({
      enabled: input.enabled,
      excludedProviders: input.excludedProviders,
      smartDynamicRouting: input.smartDynamicRouting,
      smartDynamicProxyCount: input.smartDynamicProxyCount,
    });
    addAuditEvent("proxy.settings.patched", { enabled: next.enabled });
    return next;
  });
