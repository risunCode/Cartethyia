import type { ConfigPersistence, RuntimePersistence } from "../storage";
import { getInFlightCount } from "../traffic/in-flight";
import { configuredPublicOrigin } from "./session";
import { runtimeSettings } from "./runtime-settings";
import { applySecurityHeaders } from "./static";
const TOKEN_BYTES = 24;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;
const SETUP_TTL_MS = 15 * 60_000;

type ShareKind = "monitor" | "setup";

function token(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))).toString("base64url");
}

async function tokenHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}
function origin(request: Request, config: ConfigPersistence): string {
  const configured = configuredPublicOrigin(Bun.env);
  if (configured !== null) return configured;
  if (runtimeSettings(config).trustProxy) {
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const forwardedHost = request.headers.get("x-forwarded-host");
    if (forwardedProto && forwardedHost && /^[a-z][a-z0-9+.-]*$/i.test(forwardedProto) && /^[^\s/:]+(?::\d+)?$/i.test(forwardedHost)) {
      return `${forwardedProto}://${forwardedHost}`;
    }
  }
  return new URL(request.url).origin;
}

function json(data: unknown, request: Request, status = 200): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  applySecurityHeaders(headers, request);
  return Response.json(data, { status, headers });
}

function sharePage(request: Request): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  applySecurityHeaders(headers, request);
  return new Response(Bun.file("dashboard/dist/share.html"), { headers });
}

export async function createShareLink(config: ConfigPersistence, apiKeyId: string, kind: ShareKind): Promise<{ readonly urlPath: string; readonly expiresAt: string | null }> {
  const key = config.apiKeys.getById(apiKeyId);
  if (key === null) throw new Error("API key not found");
  const raw = token();
  const expiresAt = kind === "setup" ? new Date(Date.now() + SETUP_TTL_MS).toISOString() : null;
  config.shareLinks.create({ id: crypto.randomUUID(), apiKeyId, tokenHash: await tokenHash(raw), kind, expiresAt });
  return { urlPath: kind === "setup" ? `/share/setup/${raw}` : `/share/${raw}`, expiresAt };
}

function limitRemaining(limit: number | null, used: number): number | null {
  return limit === null ? null : Math.max(0, limit - used);
}

async function monitorData(config: ConfigPersistence, runtime: RuntimePersistence, request: Request, rawToken: string): Promise<Response> {
  const link = config.shareLinks.getByTokenHash(await tokenHash(rawToken));
  if (link === null || link.kind !== "monitor" || !link.active) return json({ error: "link_not_found" }, request, 404);
  const key = config.apiKeys.getById(link.apiKeyId);
  if (key === null) return json({ error: "link_not_found" }, request, 404);
  if (link.lastViewedAt === null || Date.parse(link.lastViewedAt) < Date.now() - 60_000) config.shareLinks.touch(link.id);
  const usage = runtime.metadata.sumKeyTokens(link.apiKeyId);
  const totalRequests = runtime.metadata.countKeyRequests(link.apiKeyId);
  const dailyRemaining = limitRemaining(key.dailyTokenLimit, usage.dailyUsed);
  const monthlyRemaining = limitRemaining(key.monthlyTokenLimit, usage.monthlyUsed);
  const oneTimeRemaining = limitRemaining(key.oneTimeTokenLimit, key.oneTimeTokensUsed);
  const quotaAvailable = key.active && [dailyRemaining, monthlyRemaining, oneTimeRemaining].every((remaining) => remaining === null || remaining > 0);
  return json({
    name: key.name,
    active: key.active,
    apiKey: { id: key.id, prefix: key.keyPrefix, active: key.active },
    quotaAvailable,
    inFlight: getInFlightCount(),
    totalTokens: usage.allTimeUsed,
    totalRequests,
    dailyUsed: usage.dailyUsed,
    dailyLimit: key.dailyTokenLimit,
    dailyRemaining,
    monthlyUsed: usage.monthlyUsed,
    monthlyLimit: key.monthlyTokenLimit,
    monthlyRemaining,
    oneTimeLimit: key.oneTimeTokenLimit,
    oneTimeUsed: key.oneTimeTokensUsed,
    oneTimeRemaining,
    rateLimitRpm: key.rateLimitRpm,
    maxConcurrentRequests: key.maxConcurrentRequests,
    providerAllowlist: key.providerAllowlist ?? null,
    modelAllowlist: key.modelAllowlist ?? null,
    modelDenylist: key.modelDenylist ?? null,
    notes: {
      title: key.quoteBigText ?? null,
      subtitle: key.quoteSubText ?? null,
      body: key.quoteBody ?? null,
    },
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    baseUrl: `${origin(request, config)}/v1`,
  }, request);
}

async function setupData(config: ConfigPersistence, request: Request, rawToken: string): Promise<Response> {
  const existing = config.shareLinks.getByTokenHash(await tokenHash(rawToken));
  if (existing === null || existing.kind !== "setup") return json({ error: "link_not_found" }, request, 404);
  const consumed = config.shareLinks.consumeSetup(existing.id, new Date().toISOString());
  if (consumed === null) return json({ error: "link_expired_or_used" }, request, 410);
  const key = config.apiKeys.getById(consumed.apiKeyId);
  const secret = config.apiKeys.credential(consumed.apiKeyId);
  if (key === null || secret === null || !key.active) return json({ error: "key_unavailable" }, request, 410);
  return json({ name: key.name, key: secret, baseUrl: `${origin(request, config)}/v1`, expiresAt: consumed.expiresAt }, request);
}

export async function handleShareRequest(config: ConfigPersistence, runtime: RuntimePersistence, request: Request): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts[0] !== "share") return null;
  const setup = parts[1] === "setup";
  const rawToken = setup ? parts[2] : parts[1];
  const data = setup ? parts[3] === "data" : parts[2] === "data";
  if (!rawToken || !TOKEN_PATTERN.test(rawToken) || (data && (setup ? parts.length !== 4 : parts.length !== 3)) || (!data && (setup ? parts.length !== 3 : parts.length !== 2))) return json({ error: "not_found" }, request, 404);
  if (data) return setup ? setupData(config, request, rawToken) : monitorData(config, runtime, request, rawToken);
  return sharePage(request);
}