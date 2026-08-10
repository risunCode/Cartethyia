import { applySecurityHeaders as applyCommonSecurityHeaders } from "../security/headers";

const CONSOLE_ROOT = "dashboard/dist";
const CONSOLE_ENTRY = `${CONSOLE_ROOT}/index.html`;
const LANDING_ENTRY = `${CONSOLE_ROOT}/landing.html`;

/** Security headers applied to all console HTML/asset responses. */
export function applySecurityHeaders(headers: Headers, request: Request): void {
  applyCommonSecurityHeaders(headers, { request, html: true });
}
const IMMUTABLE_ASSET_CACHE = "public, max-age=31536000, immutable";
const PUBLIC_ASSET_CACHE = "public, max-age=604800, stale-while-revalidate=86400";

/** Applies security and cache headers to a built console asset. */
export function applyStaticAssetHeaders(headers: Headers, request: Request, assetFile: string): void {
  applySecurityHeaders(headers, request);
  headers.set("cache-control", assetFile.startsWith(`${CONSOLE_ROOT}/assets/`) ? IMMUTABLE_ASSET_CACHE : PUBLIC_ASSET_CACHE);
}

/** Keeps entry HTML revalidated so it can point at the latest hashed bundles. */
export function applyStaticEntryHeaders(headers: Headers, request: Request): void {
  applySecurityHeaders(headers, request);
  headers.set("cache-control", "no-cache, must-revalidate");
}

export type ConsoleStaticResolution =
  | { readonly kind: "entry"; readonly file: string }
  | { readonly kind: "asset"; readonly file: string }
  | { readonly kind: "not-found" };

function decodeConsolePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function isUnsafePath(relativePath: string): boolean {
  if (relativePath.includes("\\") || relativePath.startsWith("/")) return true;
  return relativePath.split("/").some((segment) => segment === ".." || segment === ".");
}

/** Resolves a console URL to a built asset or the SPA entry document. */
export async function resolveConsoleStatic(pathname: string, assetExists: (file: string) => Promise<boolean>): Promise<ConsoleStaticResolution> {
  if (pathname === "/console/api" || pathname.startsWith("/console/api/")) return { kind: "not-found" };
  if (pathname !== "/console" && !pathname.startsWith("/console/")) return { kind: "not-found" };
  const relativePath = decodeConsolePath(pathname.slice("/console".length).replace(/^\//, ""));
  if (relativePath === null || isUnsafePath(relativePath)) return { kind: "not-found" };
  if (relativePath === "" || relativePath === "index.html") return { kind: "entry", file: CONSOLE_ENTRY };

  const assetFile = `${CONSOLE_ROOT}/${relativePath}`;
  if (await assetExists(assetFile)) return { kind: "asset", file: assetFile };

  if (relativePath === "assets" || relativePath.startsWith("assets/") || relativePath.includes(".")) return { kind: "not-found" };
  return { kind: "entry", file: CONSOLE_ENTRY };
}

export type LandingStaticResolution =
  | { readonly kind: "entry"; readonly file: string }
  | { readonly kind: "asset"; readonly file: string }
  | { readonly kind: "not-found" };

/** Resolves the public landing entry and its explicitly allowed image assets. */
export async function resolveLandingStatic(pathname: string, assetExists: (file: string) => Promise<boolean>): Promise<LandingStaticResolution> {
  const relativePath = decodeConsolePath(pathname.replace(/^\//, ""));
  if (relativePath === null || isUnsafePath(relativePath)) return { kind: "not-found" };
  if (relativePath === "" || relativePath === "landing.html") return { kind: "entry", file: LANDING_ENTRY };

  const isAllowedAsset =
    relativePath === "favicon.webp" ||
    relativePath === "og_image.webp" ||
    relativePath.startsWith("when_yah/");
  if (!isAllowedAsset) return { kind: "not-found" };

  const assetFile = `${CONSOLE_ROOT}/${relativePath}`;
  if (await assetExists(assetFile)) return { kind: "asset", file: assetFile };
  return { kind: "not-found" };
}
