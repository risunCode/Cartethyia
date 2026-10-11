import crypto from "node:crypto";
import { GatewayError } from "../../../protocol/gateway-error";

export const MIMO_ACCOUNT_HOST = "account.xiaomi.com";
export const MIMO_DEFAULT_API_BASE = "https://mimo-server-sgp.xiaomimimo.com";
export const MIMO_API_UA =
  "miNative PC/Normal Windows_NT/10.0.19045 SDKV/1.0.0 DEVT/PC DEVS/Windows APP/miaccount_desktop APPV/0.1.0";
export const MIMO_SSO_UA = "MiClaw/1.0";

const SESSION_TTL_MS = 25 * 60 * 1000;

interface SessionCacheEntry {
  readonly cookie: string;
  readonly expiresAt: number;
}

const sessionCache = new Map<string, SessionCacheEntry>();
const inFlightHandshakes = new Map<string, Promise<string>>();

/**
 * Bound on both maps.
 *
 * Keys are a SHA-256 of `apiBase:passToken`, so the real bound is the number of
 * distinct MiMo credentials in play. The cap exists because these two maps are
 * the only caches in the gateway with no eviction at all: `sessionCache` is only
 * ever cleared wholesale by {@link invalidateMimoSessionCache}, and
 * `inFlightHandshakes` only by each handshake's own `finally`. A passToken that
 * rotates — re-pasted, re-issued, or a misconfigured client sending a fresh value
 * per call — therefore adds one entry per value and never releases any, which is
 * an unbounded retention on a path that runs per request.
 *
 * Evicting the oldest insertion is enough for both: a session entry is
 * re-acquired on the next miss, and a dropped handshake promise only means the
 * caller retries the handshake rather than joining a settled one.
 */
const MIMO_CACHE_MAX_ENTRIES = 256;

/** Drops the oldest insertion until `map` is within budget. */
function evictOldest<V>(map: Map<string, V>): void {
  while (map.size > MIMO_CACHE_MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function signatureClientSign(nonce: string, ssecurity?: string): string {
  let a = `nonce=${nonce}`;
  if (ssecurity && ssecurity.trim()) a += `&${ssecurity}`;
  return encodeURIComponent(crypto.createHash("sha1").update(a).digest("base64"));
}

function cookieHeader(jar: Readonly<Record<string, string>>): string {
  return Object.entries(jar)
    .filter(([, v]) => Boolean(v))
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function readSetCookies(res: Response): string[] {
  const headersObj: unknown = res.headers;
  if (headersObj && typeof headersObj === "object" && "getSetCookie" in headersObj) {
    const fn = headersObj.getSetCookie;
    if (typeof fn === "function") {
      const result: unknown = fn.call(res.headers);
      if (Array.isArray(result)) {
        return result.filter((item): item is string => typeof item === "string");
      }
    }
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function absorbSetCookie(jar: Record<string, string>, res: Response): void {
  const raw = readSetCookies(res);
  for (const c of raw) {
    const m = /^([^=]+)=([^;]*)/.exec(c.trim());
    if (m && m[1] && m[2]) jar[m[1]] = m[2];
  }
}

export interface MimoPassTokenInput {
  readonly passToken: string;
  readonly userId?: string;
  readonly apiBase?: string;
}

/**
 * Exchanges a Xiaomi passToken into a live mimo-server SSO session cookie
 * (`serviceToken`, `mimosgp_ph`, `mimosgp_slh`, `userId`) used for inference.
 */
export async function acquireMimoServiceSession(
  input: MimoPassTokenInput,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const passToken = input.passToken.trim();
  if (!passToken) {
    throw new GatewayError("authentication_failed", 401, "MiMo passToken is empty");
  }

  const apiBase = (input.apiBase ?? MIMO_DEFAULT_API_BASE).replace(/\/+$/, "");
  const cacheKey = crypto.createHash("sha256").update(`${apiBase}:${passToken}`).digest("hex");

  const cached = sessionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.cookie;
  }

  const inflight = inFlightHandshakes.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const handshakePromise = (async () => {
    try {
      const jar: Record<string, string> = { passToken };
      if (input.userId) jar["userId"] = input.userId;

      // 1. Initial ping to get SSO callback & sid
      const r1 = await fetchImpl(`${apiBase}/api/user/xiaomi/me`, {
        redirect: "manual",
        headers: { "User-Agent": MIMO_API_UA, Cookie: cookieHeader(jar) },
      });
      const redirect = r1.headers.get("location");
      if (!redirect) {
        throw new GatewayError(
          "authentication_failed",
          401,
          "Xiaomi SSO Step 1 failed: missing redirect from me endpoint",
        );
      }

      const parsedRedirect = new URL(redirect);
      const stsCallback = parsedRedirect.searchParams.get("callback");
      const sid = parsedRedirect.searchParams.get("sid") ?? "mimosgp";
      if (!stsCallback) {
        throw new GatewayError(
          "authentication_failed",
          401,
          "Xiaomi SSO Step 1 failed: missing callback query parameter",
        );
      }

      // 2. Phase 1: passportapi serviceLogin
      const sso1 = await fetchImpl(
        `https://${MIMO_ACCOUNT_HOST}/pass/serviceLogin?sid=passportapi&_json=true`,
        {
          headers: {
            Cookie: cookieHeader(jar),
            "User-Agent": MIMO_SSO_UA,
            Accept: "application/json",
          },
        },
      );
      const t1 = await sso1.text();
      let j1: Record<string, unknown> = {};
      try {
        j1 = JSON.parse(t1.replace(/^&&&START&&&/, "")) as Record<string, unknown>;
      } catch {
        throw new GatewayError("authentication_failed", 401, "Xiaomi SSO Phase 1 invalid JSON response");
      }

      const nonce = (typeof j1["nonce"] === "string" || typeof j1["nonce"] === "number" ? String(j1["nonce"]) : null) ||
        (typeof j1["location"] === "string" ? new URL(j1["location"]).searchParams.get("nonce") : null);
      const ssecurity = typeof j1["ssecurity"] === "string" ? j1["ssecurity"] : undefined;
      const loc1 = typeof j1["location"] === "string" ? j1["location"] : undefined;

      if (!nonce || !loc1) {
        throw new GatewayError(
          "authentication_failed",
          401,
          `Xiaomi SSO Phase 1 failed: code=${String(j1["code"] ?? "unknown")}, desc=${String(j1["desc"] ?? "")}`,
        );
      }

      // 3. Phase 2: passportapi clientSign
      const sso2 = await fetchImpl(`${loc1}&clientSign=${signatureClientSign(nonce, ssecurity)}`, {
        redirect: "manual",
        headers: { Cookie: cookieHeader(jar), "User-Agent": MIMO_SSO_UA },
      });
      absorbSetCookie(jar, sso2);

      // 4. Phase 3: target serviceLogin (sid=mimosgp / mimopc)
      const sso3Url = `https://${MIMO_ACCOUNT_HOST}/pass/serviceLogin?sid=${encodeURIComponent(sid)}&callback=${encodeURIComponent(stsCallback)}&_json=true`;
      const sso3 = await fetchImpl(sso3Url, {
        headers: { Cookie: cookieHeader(jar), "User-Agent": MIMO_SSO_UA, Accept: "application/json" },
      });
      const t3 = await sso3.text();
      let j3: Record<string, unknown> = {};
      try {
        j3 = JSON.parse(t3.replace(/^&&&START&&&/, "")) as Record<string, unknown>;
      } catch {
        throw new GatewayError("authentication_failed", 401, "Xiaomi SSO Phase 3 invalid JSON response");
      }

      const loc3 = typeof j3["location"] === "string" ? j3["location"] : undefined;
      if (!loc3) {
        throw new GatewayError(
          "authentication_failed",
          401,
          `Xiaomi SSO Phase 3 failed: code=${String(j3["code"] ?? "unknown")}`,
        );
      }

      // 5. Phase 4: target sts callback
      const sts = await fetchImpl(loc3, {
        redirect: "manual",
        headers: { "User-Agent": MIMO_API_UA, Cookie: cookieHeader(jar) },
      });
      absorbSetCookie(jar, sts);

      const out: Record<string, string> = {};
      for (const k of Object.keys(jar)) {
        if (k.includes("serviceToken") || k.includes("slh") || k.includes("ph") || k === "userId") {
          const val = jar[k];
          if (val) out[k] = val;
        }
      }

      if (!out["serviceToken"]) {
        throw new GatewayError(
          "authentication_failed",
          401,
          "Xiaomi SSO failed to acquire serviceToken cookie",
        );
      }

      const finalCookie = cookieHeader(out);
      sessionCache.set(cacheKey, {
        cookie: finalCookie,
        expiresAt: Date.now() + SESSION_TTL_MS,
      });
      evictOldest(sessionCache);

      return finalCookie;
    } finally {
      inFlightHandshakes.delete(cacheKey);
    }
  })();

  inFlightHandshakes.set(cacheKey, handshakePromise);
  evictOldest(inFlightHandshakes);
  return handshakePromise;
}

export function invalidateMimoSessionCache(): void {
  sessionCache.clear();
}
