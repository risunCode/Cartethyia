export const REPOSITORY_BRANCHES = ["main", "dev"] as const;

export type RepositoryBranchName = (typeof REPOSITORY_BRANCHES)[number];

export interface RepositoryBranchUpdate {
  readonly branch: RepositoryBranchName;
  readonly sha: string;
  readonly committedAt: number;
  readonly url: string;
}

export interface LocalBuildRevision {
  readonly revision: string | null;
  readonly committedAt: number | null;
  readonly startedAt: number;
}

interface RepositoryBranchPayload {
  readonly name?: unknown;
  readonly commit?: {
    readonly sha?: unknown;
    readonly commit?: {
      readonly author?: { readonly date?: unknown };
      readonly committer?: { readonly date?: unknown };
    };
    readonly html_url?: unknown;
  };
}

/** Converts a GitHub branch response into the small update record used by the dashboard. */
export function parseRepositoryBranch(branch: RepositoryBranchName, payload: unknown): RepositoryBranchUpdate | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as RepositoryBranchPayload;
  const sha = value.commit?.sha;
  const url = value.commit?.html_url;
  const date = value.commit?.commit?.committer?.date ?? value.commit?.commit?.author?.date;
  if (value.name !== branch || typeof sha !== "string" || sha.length === 0 || typeof url !== "string" || typeof date !== "string") return null;
  const committedAt = Date.parse(date);
  if (!Number.isFinite(committedAt)) return null;
  return { branch, sha, committedAt, url };
}

/** Returns whether a remote branch contains a commit newer than the running build. */
export function isRepositoryUpdateAvailable(local: LocalBuildRevision, remote: RepositoryBranchUpdate): boolean {
  if (local.revision !== null && local.revision === remote.sha) return false;
  const baseline = local.committedAt ?? local.startedAt;
  return remote.committedAt > baseline;
}

/** Returns whether a GitHub release tag is newer than the local semantic version. */
export function isNewerRelease(localVersion: string | undefined, latestTag: string | undefined): boolean {
  if (localVersion === undefined || latestTag === undefined) return false;
  const local = parseVersion(localVersion);
  const latest = parseVersion(latestTag);
  if (local === null || latest === null) return latestTag.trim() !== localVersion.trim();
  return compareVersions(latest, local) > 0;
}

type ParsedVersion = {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly (number | string)[];
};

function parseVersion(value: string): ParsedVersion | null {
  const normalized = value.trim().replace(/^v/i, "").split("+", 1)[0] ?? "";
  const [corePart, prereleasePart] = normalized.split("-", 2);
  if (corePart === undefined || !/^\d+\.\d+\.\d+$/.test(corePart)) return null;
  const coreValues = corePart.split(".").map(Number);
  if (coreValues.length !== 3 || coreValues.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
  const prerelease = prereleasePart === undefined || prereleasePart.length === 0
    ? []
    : prereleasePart.split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part);
  if (prerelease.some((part) => typeof part === "number" && (!Number.isSafeInteger(part) || part < 0))) return null;
  return { core: [coreValues[0] ?? 0, coreValues[1] ?? 0, coreValues[2] ?? 0], prerelease };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    const leftPart = left.core[index] ?? 0;
    const rightPart = right.core[index] ?? 0;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1;
  if (left.prerelease.length > 0 && right.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "string") return -1;
    if (typeof leftPart === "string" && typeof rightPart === "number") return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}
