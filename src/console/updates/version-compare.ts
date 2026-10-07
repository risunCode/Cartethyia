/**
 * Semantic version comparison for the update indicator.
 *
 * Pure so the dashboard can import it: no Elysia, no Node builtins, no fetch.
 * The console shows a badge only when a remote tag is genuinely newer than the
 * running build, so a dev build running ahead of the last release stays quiet.
 */

/** `1.2.3` plus an optional prerelease; build metadata after `+` is ignored. */
interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly (number | string)[];
}

/** Parses a tag or version string. Returns `null` when it is not semver. */
export function parseVersion(value: string): ParsedVersion | null {
  const normalized = value.trim().replace(/^v/i, "").split("+", 1)[0] ?? "";
  const [corePart, prereleasePart] = normalized.split("-", 2);
  if (corePart === undefined || !/^\d+\.\d+\.\d+$/.test(corePart)) return null;
  const coreValues = corePart.split(".").map(Number);
  if (coreValues.length !== 3 || coreValues.some((part) => !Number.isSafeInteger(part) || part < 0))
    return null;
  const prerelease =
    prereleasePart === undefined || prereleasePart.length === 0
      ? []
      : prereleasePart.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  if (prerelease.some((part) => typeof part === "number" && (!Number.isSafeInteger(part) || part < 0)))
    return null;
  return { core: [coreValues[0] ?? 0, coreValues[1] ?? 0, coreValues[2] ?? 0], prerelease };
}

/**
 * Returns whether `latestTag` is newer than `localVersion`.
 *
 * An unparseable side falls back to a trimmed string comparison, which is the
 * conservative answer: a dev build labelled `2.0-dev` is not silently claimed
 * to be behind a release it cannot be compared against numerically.
 */
export function isNewerRelease(localVersion: string | undefined, latestTag: string | undefined): boolean {
  if (localVersion === undefined || latestTag === undefined) return false;
  const local = parseVersion(localVersion);
  const latest = parseVersion(latestTag);
  if (local === null || latest === null) return latestTag.trim() !== localVersion.trim();
  return compareVersions(latest, local) > 0;
}

/** Orders two parsed versions: 1 when `left` is newer, -1 when older, 0 equal. */
export function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    const leftPart = left.core[index] ?? 0;
    const rightPart = right.core[index] ?? 0;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  // A release outranks its own prereleases: 1.0.0 ships after 1.0.0-rc.1.
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1;
  if (left.prerelease.length > 0 && right.prerelease.length === 0) return -1;
  for (
    let index = 0;
    index < Math.max(left.prerelease.length, right.prerelease.length);
    index += 1
  ) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    // Numeric identifiers rank below alphanumeric ones, per semver.
    if (typeof leftPart === "number" && typeof rightPart === "string") return -1;
    if (typeof leftPart === "string" && typeof rightPart === "number") return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}
