/**
 * Console web serving — serves dashboard/dist at /console with SPA fallback.
 * When the dashboard is not built, a placeholder page is shown instead of 500.
 */

import { Elysia, redirect } from "elysia";
import type { HTTPHeaders } from "elysia";
import { join, normalize, sep } from "node:path";
import { existsSync, statSync, readFileSync } from "node:fs";

const DIST = join(import.meta.dir, "../../dashboard/dist");
const LANDING_ASSETS = join(import.meta.dir, "landing-assets");
const LANDING_VIDEO_NAME = "echoborn-cartethyia-awakens.1920x1080.mp4";
const LANDING_VIDEO = join(import.meta.dir, "../../dashboard/public/CartethyiaPi", LANDING_VIDEO_NAME);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
};

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Cartethyia Console</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#f2f2f5;color:#1d1d1f;display:grid;place-items:center;min-height:100vh;margin:0}
.box{background:rgba(255,255,255,.7);backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,.6);border-radius:18px;padding:32px 40px;box-shadow:0 12px 32px rgba(0,0,0,.08);text-align:center}
code{background:rgba(0,0,0,.06);padding:2px 8px;border-radius:6px}</style></head>
<body><div class="box"><h1 style="margin:0 0 8px">Dashboard not built</h1>
<p style="margin:0;color:#6e6e73">Run <code>cd dashboard && bun run build</code> then reload.</p></div></body>
</html>`;

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

const CSP_HEADER = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'";
// 2-year HSTS: only set on HTTPS responses (detected by the Secure cookie guard).
// The header is harmless if accidentally served over HTTP (browsers require HTTPS for HSTS to activate).
const HSTS_HEADER = "max-age=63072000; includeSubDomains";

/** Injects security headers shared by all console HTML responses. */
function applyConsoleSecurityHeaders(set: { headers: HTTPHeaders }, request: Request): void {
  set.headers["content-security-policy"] = CSP_HEADER;
  // HSTS — only meaningful for HTTPS; browsers ignore it on plain HTTP.
  if (request.url.startsWith("https://") || request.headers.get("x-forwarded-proto") === "https") {
    set.headers["strict-transport-security"] = HSTS_HEADER;
  }
}

/** Serves the SPA shell; falls back to a placeholder when the dashboard is unbuilt. */
function appShell(set: { headers: HTTPHeaders }, request: Request): string {
  set.headers["content-type"] = "text/html; charset=utf-8";
  applyConsoleSecurityHeaders(set, request);
  if (!existsSync(DIST)) return PLACEHOLDER_HTML;
  return readFileSync(join(DIST, "index.html"), "utf-8");
}

export const consoleWebRoutes = new Elysia()
  .get("/landing-assets/*", ({ params, set }) => {
    const wildcard = (params as Record<string, string>)["*"] ?? "";
    const safe = normalize(wildcard).replace(/^(\.\.[/\\])+/, "");
    const isHeroVideo = safe === LANDING_VIDEO_NAME;
    const filePath = isHeroVideo ? LANDING_VIDEO : join(LANDING_ASSETS, safe);
    if (!isHeroVideo && filePath !== LANDING_ASSETS && !filePath.startsWith(LANDING_ASSETS + sep)) {
      set.status = 403;
      return "forbidden";
    }
    if (safe === "" || !existsSync(filePath) || !statSync(filePath).isFile()) {
      set.status = 404;
      return "not found";
    }
    const extension = extensionOf(filePath);
    set.headers["cache-control"] = extension === ".js" ? "no-cache" : "public, max-age=86400, immutable";
    return new Response(Bun.file(filePath), {
      headers: { "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream" },
    });
  })
  // Elysia registers a loose alias, so this route answers both `/console` and
  // `/console/`. Redirecting unconditionally would loop, hence the path check.
  .get("/console", ({ request, set }) => {
    const { pathname } = new URL(request.url);
    return pathname.endsWith("/") ? appShell(set, request) : redirect("/console/");
  })
  .get("/console/*", ({ params, set, request }) => {
    const wildcard = (params as Record<string, string>)["*"] ?? "";
    const safe = normalize(wildcard).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(DIST, safe);
    if (filePath !== DIST && !filePath.startsWith(DIST + sep)) {
      set.status = 403;
      return "forbidden";
    }
    if (safe !== "" && existsSync(filePath) && statSync(filePath).isFile()) {
      const contentType = CONTENT_TYPES[extensionOf(filePath)] ?? "application/octet-stream";
      return new Response(Bun.file(filePath), { headers: { "content-type": contentType } });
    }
    // A path carrying a file extension is asking for an asset, not a route.
    // Serving the shell there would hand HTML to an <img>/<script> tag, so a
    // miss must be an honest 404; only route-shaped paths get the shell.
    if (extensionOf(safe) !== "") {
      set.status = 404;
      return "not found";
    }

    // SPA fallback: unknown paths render the app shell (client router decides).
    return appShell(set, request);
  });
