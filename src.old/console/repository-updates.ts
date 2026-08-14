const REPOSITORY = "risunCode/Cartethyia";
const BRANCHES = ["main", "dev"] as const;

export interface RepositoryRelease {
  readonly tag_name: string;
  readonly html_url: string;
}
export interface RepositoryUpdateBranch {
  readonly branch: (typeof BRANCHES)[number];
  readonly sha: string;
  readonly committedAt: number;
  readonly url: string;
}

interface GitHubBranchResponse {
  readonly name?: unknown;
  readonly commit?: {
    readonly sha?: unknown;
    readonly html_url?: unknown;
    readonly commit?: {
      readonly author?: { readonly date?: unknown };
      readonly committer?: { readonly date?: unknown };
    };
  };
}

/** Fetches the public main/dev heads without exposing GitHub CORS or rate-limit failures to the browser. */
export async function fetchRepositoryUpdates(): Promise<readonly RepositoryUpdateBranch[]> {
  const results = await Promise.all(BRANCHES.map((branch) => fetchBranch(branch)));
  return results.filter((branch): branch is RepositoryUpdateBranch => branch !== null);
}
/** Fetches the latest public release through the server-side updater boundary. */
export async function fetchLatestRelease(): Promise<RepositoryRelease | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Cartethyia-updater" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const value = await response.json() as { readonly tag_name?: unknown; readonly html_url?: unknown };
    if (typeof value.tag_name !== "string" || typeof value.html_url !== "string") return null;
    return { tag_name: value.tag_name, html_url: value.html_url };
  } catch {
    return null;
  }
}

async function fetchBranch(branch: (typeof BRANCHES)[number]): Promise<RepositoryUpdateBranch | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/branches/${branch}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Cartethyia-updater" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const value = await response.json() as GitHubBranchResponse;
    const sha = value.commit?.sha;
    const url = value.commit?.html_url;
    const date = value.commit?.commit?.committer?.date ?? value.commit?.commit?.author?.date;
    if (value.name !== branch || typeof sha !== "string" || sha.length === 0 || typeof url !== "string" || typeof date !== "string") return null;
    const committedAt = Date.parse(date);
    if (!Number.isFinite(committedAt)) return null;
    return { branch, sha, committedAt, url };
  } catch {
    return null;
  }
}
