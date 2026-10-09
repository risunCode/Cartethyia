/**
 * Cross-app constants with a single owner.
 *
 * A constant duplicated per hook drifts silently: one copy gets tuned during a
 * bug fix and the others keep the old value, so identical streams reconnect on
 * different schedules. Anything referenced by more than one module belongs here.
 */

/** Delay before a dropped console SSE stream is re-opened. */
export const STREAM_RETRY_MS = 5_000;

/**
 * The public upstream repository. One owner so the update badge and the release
 * link cannot point at different projects.
 */
export const GITHUB_REPO = "risunCode/Cartethyia";
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO}`;
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;
