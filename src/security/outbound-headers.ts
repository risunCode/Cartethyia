// Central header protection for outbound custom-header validation.
import { createHash } from "node:crypto";

/**
 * Content-Security-Policy for non-document (JSON/API) responses. The gateway
 * never serves scripts, frames, or forms from these endpoints, so everything
 * is denied. `frame-ancestors 'none'` also covers clickjacking for browsers
 * that ignore `X-Frame-Options`.
 */
export const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

/** Legacy clickjacking guard for clients that predate CSP `frame-ancestors`. */
export const X_FRAME_OPTIONS = "DENY";

/**
 * Security headers on every `/v1` response, whichever path produced it.
 *
 * Three paths used to hand-copy this list — the request-context middleware,
 * the error encoder, and the upstream success projection — and they had
 * already drifted: the success path was missing the CSP pair. One list means a
 * future hardening cannot land on one path and miss the others.
 *
 * Carrying the CSP pair on the success path is safe because every surface
 * adapter emits `application/json` or `text/event-stream`, never a renderable
 * document. Console and `/share` responses keep their own narrower set.
 */
export const GATEWAY_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": API_CONTENT_SECURITY_POLICY,
  "x-frame-options": X_FRAME_OPTIONS,
});

/** CSP source expression for one inline script body (base64 SHA-256). */
export function inlineScriptHash(scriptBody: string): string {
  return `'sha256-${createHash("sha256").update(scriptBody, "utf8").digest("base64")}'`;
}

/**
 * Extracts the bodies of inline `<script>` tags (those without a `src`
 * attribute) so the dashboard CSP can allow exactly those scripts by hash
 * instead of enabling `'unsafe-inline'`.
 */
export function inlineScriptBodies(html: string): readonly string[] {
  const bodies: string[] = [];
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const body = match[1] ?? "";
    if (body.trim().length > 0) bodies.push(body);
  }
  return bodies;
}

/**
 * Content-Security-Policy for the dashboard document. Scripts are restricted
 * to the bundled same-origin modules plus hashes of the static inline theme
 * bootstrap; styles allow inline (React `style` props) and Google Fonts.
 */
export function dashboardContentSecurityPolicy(html: string): string {
  const hashes = inlineScriptBodies(html).map(inlineScriptHash);
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.length > 0 ? ` ${hashes.join(" ")}` : ""}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Content-Security-Policy for small self-contained console HTML pages (e.g.
 * the OAuth callback result). The default API policy denies scripts entirely,
 * so pages that must run an inline script declare its hash here to override it.
 */
export function inlineScriptContentSecurityPolicy(scriptBodies: readonly string[]): string {
  const hashes = scriptBodies.map(inlineScriptHash);
  return [
    "default-src 'none'",
    `script-src${hashes.length > 0 ? ` ${hashes.join(" ")}` : " 'none'"}`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const BASE_PROTECTED_HEADERS: Readonly<Record<string, true>> = Object.freeze({
  host: true,
  "content-type": true,
  "content-length": true,
  authorization: true,
  "x-api-key": true,
  cookie: true,
  connection: true,
  "keep-alive": true,
  "proxy-connection": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
  via: true,
  forwarded: true,
  "x-real-ip": true,
  "x-forwarded-for": true,
  "x-forwarded-host": true,
  "x-forwarded-proto": true,
  "x-forwarded-port": true,
  "x-forwarded-prefix": true,
  "x-cartethyia-surface": true,
  "x-cartethyia-tenant": true,
});

export const HEADER_TOKEN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const HEADER_CONTROL = /[\r\n\x00-\x1f\x7f]/;

export function isProtectedHeader(name: string, extra: Readonly<Record<string, true>> = {}): boolean {
  const lower = name.toLowerCase();
  if (BASE_PROTECTED_HEADERS[lower] || extra[lower]) return true;
  if (lower.startsWith("x-forwarded-")) return true;
  return false;
}
