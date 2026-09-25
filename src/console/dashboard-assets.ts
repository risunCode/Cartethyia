import { resolve } from "path";
import {
  API_CONTENT_SECURITY_POLICY,
  X_FRAME_OPTIONS,
  dashboardContentSecurityPolicy,
} from "../security/outbound-headers";

/**
 * Represents the result of serving a static file.
 */
export interface StaticServeResult {
  status: number;
  body: Uint8Array | undefined;
  headers: Record<string, string>;
}

/**
 * Configuration for the static file handler.
 */
export interface StaticHandlerConfig {
  /** Absolute path to the dashboard build directory */
  buildDir: string;
  /**
   * SPA entry documents are keyed by URL prefix. A request whose path is not a
   * real file but sits under one of these prefixes is served that document so
   * the client can resolve the route.
   */
  entries?: Readonly<Record<string, string>>;
}

/** Shared landing, console, and public share entry document produced by Vite. */
export const DEFAULT_ENTRY_DOCUMENTS: Readonly<Record<string, string>> = {
  "/": "index.html",
  "/share": "index.html",
  "/console": "index.html",
};

/** Longest-prefix match of an SPA route against the configured entry documents. */
function entryDocumentFor(pathname: string, entries: Readonly<Record<string, string>>): string | undefined {
  let matched: string | undefined;
  let matchedLength = -1;
  for (const [prefix, document] of Object.entries(entries)) {
    const isRoot = prefix === "/";
    const matches = isRoot ? pathname === "/" : pathname === prefix || pathname.startsWith(`${prefix}/`);
    if (!matches) continue;
    if (prefix.length > matchedLength) {
      matched = document;
      matchedLength = prefix.length;
    }
  }
  return matched;
}

/**
 * Creates a hardened multi-page static file handler for the public routes.
 *
 * - Serves the shared index at `/`, `/share/*`, and `/console/*` for
 *   extensionless client-side routes
 * - Serves real files (assets, provider icons, chapter art) from the build root
 * - Safely decodes and normalizes request paths, rejecting traversal
 * - Rejects the reserved `/console/api` namespace defensively
 * - Serves hashed assets with immutable cache headers and documents with no-cache
 * - Returns 404 for missing asset-like files
 */
export function createStaticHandler(
  config: StaticHandlerConfig,
): (pathname: string) => Promise<StaticServeResult> {
  const buildDirResolved = resolve(config.buildDir);
  const buildDirNorm = normalizePathSeparators(buildDirResolved);
  const entries = config.entries ?? DEFAULT_ENTRY_DOCUMENTS;

  const serveDocument = async (document: string): Promise<StaticServeResult> => {
    const file = Bun.file(resolve(buildDirResolved, document));
    if (!(await file.exists())) {
      return { status: 404, body: undefined, headers: {} };
    }
    return {
      status: 200,
      body: await file.bytes(),
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache, must-revalidate",
      },
    };
  };

  const serve = async (pathname: string): Promise<StaticServeResult> => {
    // Reject the reserved `/console/api` namespace, including its bare prefix.
    if (pathname === "/console/api" || pathname.startsWith("/console/api/")) {
      return {
        status: 404,
        body: undefined,
        headers: { "content-type": "application/json" },
      };
    }

    // Decode the path to handle URL-encoded characters
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      return { status: 404, body: undefined, headers: {} };
    }

    const normalizedPath = normalizePathSeparators(decodedPath);
    // The console document is mounted under `/console`, but the Vite build
    // emits assets at the origin root (base `/`). Strip the mount prefix so
    // `/console/assets/app.js` resolves to the same file as `/assets/app.js`.
    // The prefix is only stripped when present: a leading slash on any other
    // path is preserved so `resolve` treats it as absolute and the containment
    // check below rejects it.
    const relativePath = normalizedPath.startsWith("/console/")
      ? normalizedPath.slice("/console/".length)
      : normalizedPath.replace(/^\/+/, "");

    // Security check: the resolved path must stay inside the build directory.
    // This rejects `..` traversal, absolute paths, and normalized backslashes.
    const fullPath = resolve(buildDirResolved, relativePath);
    const fullPathNorm = normalizePathSeparators(fullPath);
    const buildDirWithSlash = buildDirNorm + (buildDirNorm.endsWith("/") ? "" : "/");
    const insideBuildDir =
      fullPathNorm === buildDirNorm || fullPathNorm.startsWith(buildDirWithSlash);
    if (!insideBuildDir) {
      return { status: 404, body: undefined, headers: {} };
    }

    const entryDocument = entryDocumentFor(normalizedPath, entries);
    const lastSegment = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    // A missing path with a dot is an asset request and must 404 rather than
    // falling back to the SPA document.
    const isAssetLike = lastSegment.includes(".");

    if (relativePath.length > 0) {
      try {
        const file = Bun.file(fullPath);
        if (await file.exists()) {
          const data = await file.bytes();
          const mimeType = getMimeType(fullPath);

          // Determine cache headers based on file type
          let cacheControl: string;
          if (relativePath === "index.html" || relativePath.endsWith("/index.html")) {
            cacheControl = "no-cache, must-revalidate";
          } else if (hasHashInFilename(fullPath)) {
            // Hashed assets (e.g., app.abc123.js) are immutable
            cacheControl = "public, max-age=31536000, immutable";
          } else if (!relativePath.includes(".")) {
            // Extensionless paths (SPA routes)
            cacheControl = "no-cache, must-revalidate";
          } else {
            // Regular assets without hash
            cacheControl = "public, max-age=3600";
          }

          return {
            status: 200,
            body: data,
            headers: { "content-type": mimeType, "cache-control": cacheControl },
          };
        }
      } catch {
        return { status: 404, body: undefined, headers: {} };
      }
    }

    // No file on disk: hand the route to its SPA document when one owns it.
    if (entryDocument !== undefined && !isAssetLike) {
      return serveDocument(entryDocument);
    }

    return { status: 404, body: undefined, headers: {} };
  };

  return async (pathname: string): Promise<StaticServeResult> =>
    applyStaticSecurityHeaders(await serve(pathname));
}

/**
 * Adds the browser-hardening headers shared by every `/console/*` response.
 * Documents get the dashboard CSP (inline scripts allowed only by hash);
 * non-document assets get the locked-down API policy so no static response is
 * ever served without an explicit CSP.
 */
function applyStaticSecurityHeaders(result: StaticServeResult): StaticServeResult {
  const contentType = result.headers["content-type"] ?? "";
  const isHtml = contentType.includes("text/html");
  const csp = isHtml
    ? dashboardContentSecurityPolicy(result.body ? new TextDecoder().decode(result.body) : "")
    : API_CONTENT_SECURITY_POLICY;
  return {
    ...result,
    headers: {
      ...result.headers,
      "x-content-type-options": "nosniff",
      "x-frame-options": X_FRAME_OPTIONS,
      "referrer-policy": "no-referrer",
      "content-security-policy": csp,
    },
  };
}

/**
 * Normalizes path separators to forward slashes for consistent comparison.
 */
function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Determines the MIME type of a file based on its extension.
 */
function getMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
  const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".otf": "font/otf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".gz": "application/gzip",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Checks if a filename contains a hash (common pattern: name.hash.ext).
 * This is a heuristic that looks for hex-like strings in the filename.
 */
function hasHashInFilename(filePath: string): boolean {
  const filename = filePath.split(/[/\\]/).pop() || "";
  // Match patterns like: app.abc123def.js, script.12345678.mjs, etc.
  // Look for segments that are at least 8 characters of hex digits
  const hashPattern = /\.[a-f0-9]{6,}\./i;
  return hashPattern.test(filename);
}
