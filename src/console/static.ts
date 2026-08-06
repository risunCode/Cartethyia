const CONSOLE_ROOT = "dashboard/dist";
const CONSOLE_ENTRY = `${CONSOLE_ROOT}/index.html`;

const CSP_HEADER = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'";
const HSTS_HEADER = "max-age=63072000; includeSubDomains";

/** Security headers applied to all console HTML/asset responses. */
export function applySecurityHeaders(headers: Headers, request: Request): void {
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("content-security-policy", CSP_HEADER);
  const isHttps = request.url.startsWith("https://") || request.headers.get("x-forwarded-proto") === "https";
  if (isHttps) headers.set("strict-transport-security", HSTS_HEADER);
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
