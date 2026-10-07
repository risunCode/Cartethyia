/**
 * Public release discovery for the console's update indicator.
 *
 * The browser never talks to GitHub directly: a dashboard-side fetch would put
 * every console user's GitHub rate limit behind one shared, unauthenticated
 * origin, and a CORS or rate-limit failure would surface as a console error
 * nobody can act on. The request is made here, server-side, and any failure
 * degrades to "no update known" rather than an error the operator must read.
 */
const REPOSITORY = "risunCode/Cartethyia";

/** Timeout for one GitHub read. A hung read must not hold a console query open. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface LatestRelease {
  readonly tag_name: string;
  readonly html_url: string;
}

/** Fetches the latest public release. Returns `null` when none is known. */
export async function fetchLatestRelease(): Promise<LatestRelease | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Cartethyia-updater" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const value = (await response.json()) as { readonly tag_name?: unknown; readonly html_url?: unknown };
    if (typeof value.tag_name !== "string" || typeof value.html_url !== "string") return null;
    return { tag_name: value.tag_name, html_url: value.html_url };
  } catch {
    return null;
  }
}
