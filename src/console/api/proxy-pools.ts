/**
 * Proxy pools API — CRUD + per-entry test + line-based import (REQ-14, design §5.7).
 */

import { Elysia } from "elysia";
import { consoleError } from "../errors";
import { addAuditEvent } from "../db/repos/audit";
import {
  listPools,
  getPool,
  createPool,
  updatePool,
  deletePool,
  parseImportText,
  parseProxyUrl,
  testProxyEntry,
  testPool,
  type ProxyEntry,
} from "../db/repos/proxy-pools";

function validateEntries(raw: unknown): ProxyEntry[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const entries: ProxyEntry[] = [];
  for (const item of raw) {
    const url = typeof item === "string" ? item : (item as { url?: string })?.url;
    if (typeof url !== "string") return null;
    const parsed = parseProxyUrl(url);
    if (!parsed) return null;
    entries.push(parsed);
  }
  return entries;
}

export const proxyPoolsRoutes = new Elysia({ prefix: "/console/api/proxy-pools" })
  .get("/", () => ({ items: listPools() }))
  .get("/:id", ({ params, set }) => {
    const pool = getPool(params.id);
    if (!pool) {
      set.status = 404;
      return consoleError("not_found", "proxy pool not found");
    }
    return pool;
  })
  .post("/", ({ body, set }) => {
    const input = (body ?? {}) as { name?: string; entries?: unknown; noProxy?: string; strictProxy?: boolean; platform?: string };
    if (!input.name?.trim()) {
      set.status = 400;
      return consoleError("invalid_request", "name is required");
    }
    const entries = validateEntries(input.entries);
    if (!entries) {
      set.status = 400;
      return consoleError("invalid_request", "entries must be a non-empty array of valid proxy URLs (http/https/socks5)");
    }
    const platform = ["custom", "cloudflare", "vercel"].includes(input.platform ?? "") ? (input.platform as "custom" | "cloudflare" | "vercel") : "custom";
    try {
      const pool = createPool({ name: input.name.trim(), entries, noProxy: input.noProxy, strictProxy: input.strictProxy, platform });
      addAuditEvent("proxy_pool.create", { id: pool.id, name: pool.name, entryCount: entries.length });
      set.status = 201;
      return pool;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set.status = message.includes("UNIQUE") ? 409 : 500;
      return consoleError(message.includes("UNIQUE") ? "conflict" : "internal", message.includes("UNIQUE") ? "a pool with this name already exists" : message);
    }
  })
  .post("/:id", ({ params, body, set }) => {
    const input = (body ?? {}) as { name?: string; entries?: unknown; noProxy?: string; strictProxy?: boolean; platform?: string };
    let entries: ProxyEntry[] | undefined;
    if (input.entries !== undefined) {
      const validated = validateEntries(input.entries);
      if (!validated) {
        set.status = 400;
        return consoleError("invalid_request", "entries must be a non-empty array of valid proxy URLs (http/https/socks5)");
      }
      entries = validated;
    }
    const platform = input.platform !== undefined && ["custom", "cloudflare", "vercel"].includes(input.platform) ? input.platform as "custom" | "cloudflare" | "vercel" : undefined;
    const updated = updatePool(params.id, {
      name: input.name?.trim(),
      entries,
      noProxy: input.noProxy,
      strictProxy: input.strictProxy,
      platform,
    });
    if (!updated) {
      set.status = 404;
      return consoleError("not_found", "proxy pool not found");
    }
    addAuditEvent("proxy_pool.update", { id: params.id });
    return { ok: true };
  })
  .delete("/:id", ({ params, set }) => {
    const removed = deletePool(params.id);
    if (!removed) {
      set.status = 404;
      return consoleError("not_found", "proxy pool not found");
    }
    addAuditEvent("proxy_pool.delete", { id: params.id });
    return { ok: true };
  })
  .post("/import", ({ body, set }) => {
    const { text } = (body ?? {}) as { text?: string };
    if (typeof text !== "string" || !text.trim()) {
      set.status = 400;
      return consoleError("invalid_request", "text is required");
    }
    return parseImportText(text);
  })
  .post("/:id/test", async ({ params, set }) => {
    const results = await testPool(params.id);
    if (!results) {
      set.status = 404;
      return consoleError("not_found", "proxy pool not found");
    }
    return { items: results };
  })
  .post("/test-entry", async ({ body, set }) => {
    const { url } = (body ?? {}) as { url?: string };
    if (typeof url !== "string" || !parseProxyUrl(url)) {
      set.status = 400;
      return consoleError("invalid_request", "url must be a valid proxy URL");
    }
    return testProxyEntry(url);
  });
