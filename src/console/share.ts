import type { ConfigPersistence, RuntimePersistence } from "../storage";

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

function origin(request: Request): string {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedProto && forwardedHost && /^[a-z][a-z0-9+.-]*$/i.test(forwardedProto) && /^[^\s/:]+(?::\d+)?$/i.test(forwardedHost)) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  return url.origin;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function noStoreHtml(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function page(title: string, script: string): Response {
  return noStoreHtml(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;background:#0b1020;color:#edf2ff}main{border:1px solid #2c3657;border-radius:16px;padding:24px;background:#121a31}h1{font-size:22px}p{color:#aeb9d8}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.card{border:1px solid #2c3657;border-radius:10px;padding:14px}.label{font-size:12px;color:#94a3c7}.value{font-size:20px;margin-top:5px;word-break:break-word}code{display:block;padding:12px;border-radius:8px;background:#080c18;word-break:break-all}button{border:0;border-radius:8px;padding:10px 14px;background:#89a7ff;color:#091024;font-weight:700;cursor:pointer}</style></head><body><main><h1>${escapeHtml(title)}</h1><div id="app"><p>Loading…</p></div></main><script>${script}</script></body></html>`);
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
  if (link === null || link.kind !== "monitor" || !link.active) return json({ error: "link_not_found" }, 404);
  const key = config.apiKeys.getById(link.apiKeyId);
  if (key === null) return json({ error: "link_not_found" }, 404);
  if (link.lastViewedAt === null || Date.parse(link.lastViewedAt) < Date.now() - 60_000) config.shareLinks.touch(link.id);
  const usage = runtime.metadata.sumKeyTokens(link.apiKeyId);
  return json({
    name: key.name,
    keyPrefix: key.keyPrefix,
    active: key.active,
    dailyUsed: usage.dailyUsed,
    dailyRemaining: limitRemaining(key.dailyTokenLimit, usage.dailyUsed),
    monthlyUsed: usage.monthlyUsed,
    monthlyRemaining: limitRemaining(key.monthlyTokenLimit, usage.monthlyUsed),
    oneTimeRemaining: limitRemaining(key.oneTimeTokenLimit, key.oneTimeTokensUsed),
    rateLimitRpm: key.rateLimitRpm,
    maxConcurrentRequests: key.maxConcurrentRequests,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    baseUrl: `${origin(request)}/v1`,
  });
}

async function setupData(config: ConfigPersistence, request: Request, rawToken: string): Promise<Response> {
  const existing = config.shareLinks.getByTokenHash(await tokenHash(rawToken));
  if (existing === null || existing.kind !== "setup") return json({ error: "link_not_found" }, 404);
  const consumed = config.shareLinks.consumeSetup(existing.id, new Date().toISOString());
  if (consumed === null) return json({ error: "link_expired_or_used" }, 410);
  const key = config.apiKeys.getById(consumed.apiKeyId);
  const secret = config.apiKeys.credential(consumed.apiKeyId);
  if (key === null || secret === null || !key.active) return json({ error: "key_unavailable" }, 410);
  return json({ name: key.name, key: secret, baseUrl: `${origin(request)}/v1`, expiresAt: consumed.expiresAt });
}

export async function handleShareRequest(config: ConfigPersistence, runtime: RuntimePersistence, request: Request): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts[0] !== "share") return null;
  const setup = parts[1] === "setup";
  const rawToken = setup ? parts[2] : parts[1];
  const data = setup ? parts[3] === "data" : parts[2] === "data";
  if (!rawToken || !TOKEN_PATTERN.test(rawToken) || (data && (setup ? parts.length !== 4 : parts.length !== 3)) || (!data && (setup ? parts.length !== 3 : parts.length !== 2))) return json({ error: "not_found" }, 404);
  if (data) return setup ? setupData(config, request, rawToken) : monitorData(config, runtime, request, rawToken);
  const dataPath = setup ? `/share/setup/${rawToken}/data` : `/share/${rawToken}/data`;
  if (setup) {
    return page("API key setup link", `const app=document.querySelector('#app');fetch(${JSON.stringify(dataPath)}).then(async r=>{const d=await r.json();if(!r.ok){app.innerHTML='<p>This setup link is expired or already used.</p>';return;}app.innerHTML='<p>Use these values in your client. This page will not show the key again.</p><div class="card"><div class="label">Base URL</div><code>'+d.baseUrl+'</code></div><div class="card"><div class="label">API key</div><code>'+d.key+'</code></div>';}).catch(()=>app.innerHTML='<p>Unable to load setup data.</p>');`);
  }
  return page("API usage monitor", `const app=document.querySelector('#app');const esc=s=>String(s??'—').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));const fmt=v=>v==null?'Unlimited':Number(v).toLocaleString();async function load(){const r=await fetch(${JSON.stringify(dataPath)});const d=await r.json();if(!r.ok){app.innerHTML='<p>This monitor link is unavailable.</p>';return;}app.innerHTML='<p><b>'+esc(d.name)+'</b> · '+esc(d.keyPrefix)+(d.active?'':' · disabled')+'</p><div class="grid"><div class="card"><div class="label">Today</div><div class="value">'+fmt(d.dailyUsed)+' / '+fmt(d.dailyRemaining)+'</div></div><div class="card"><div class="label">This month</div><div class="value">'+fmt(d.monthlyUsed)+' / '+fmt(d.monthlyRemaining)+'</div></div><div class="card"><div class="label">One-time remaining</div><div class="value">'+fmt(d.oneTimeRemaining)+'</div></div><div class="card"><div class="label">Rate limit</div><div class="value">'+fmt(d.rateLimitRpm)+' RPM</div></div></div><p>Base URL: <code>'+esc(d.baseUrl)+'</code></p>';}load();setInterval(load,15000);`);
}