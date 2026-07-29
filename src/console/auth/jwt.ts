/**
 * JWT HS256 — zero-dependency sign/verify via WebCrypto.
 *
 * Verification recomputes the signature and compares it in constant time,
 * then checks expiry and the settings password_version (`pv`) so a password
 * change instantly invalidates every previously issued token.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ConsoleJwtPayload {
  role: "admin";
  /** settings.password_version at issue time. */
  pv: number;
  jti: string;
  iat: number;
  exp: number;
}

function base64UrlEncode(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const b64 = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export interface SignOptions {
  secret: string;
  pv: number;
  ttlSeconds: number;
  nowSeconds?: number;
}

export async function signConsoleJwt(options: SignOptions): Promise<string> {
  const iat = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: ConsoleJwtPayload = {
    role: "admin",
    pv: options.pv,
    jti: crypto.randomUUID(),
    iat,
    exp: iat + options.ttlSeconds,
  };
  const header = { alg: "HS256", typ: "JWT" };
  const data = `${base64UrlEncode(encoder.encode(JSON.stringify(header)))}.${base64UrlEncode(encoder.encode(JSON.stringify(payload)))}`;
  const key = await importHmacKey(options.secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return `${data}.${base64UrlEncode(signature)}`;
}

export type VerifyFailure = "malformed" | "signature" | "expired" | "stale_pv";
export type VerifyResult = { ok: true; payload: ConsoleJwtPayload } | { ok: false; reason: VerifyFailure };

export interface VerifyOptions {
  secret: string;
  expectedPv: number;
  nowSeconds?: number;
}

export async function verifyConsoleJwt(token: string | undefined | null, options: VerifyOptions): Promise<VerifyResult> {
  if (!token) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [head, body, sig] = parts as [string, string, string];

  const key = await importHmacKey(options.secret);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${head}.${body}`)));
  const given = base64UrlDecode(sig);
  if (given.length !== expected.length) return { ok: false, reason: "signature" };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ given[i]!;
  if (diff !== 0) return { ok: false, reason: "signature" };

  let payload: ConsoleJwtPayload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecode(body))) as ConsoleJwtPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return { ok: false, reason: "expired" };
  if (payload.pv !== options.expectedPv) return { ok: false, reason: "stale_pv" };
  return { ok: true, payload };
}
