import type { ReactElement } from "react";

/**
 * Canonical repository link shared by every public surface, so the landing page
 * and the share page cannot drift onto different repositories.
 */
export const GITHUB_REPO_URL = "https://github.com/risunCode/Cartethyia";

/**
 * The badge host, declared here rather than imported from the backend CSP
 * module: that module reads `node:crypto` and browser code must not pull in a
 * Node-only runtime dependency. The two must be kept in agreement by hand —
 * the dashboard CSP must name this origin, or the badge is silently blocked
 * behind a CSP violation.
 */
export const BADGE_IMAGE_ORIGIN = "https://img.shields.io";

const REPO_SLUG = "risunCode/Cartethyia";

/**
 * Live star and fork counts, as shields.io SVG badges.
 *
 * The counts arrive as `<img>` rather than a `fetch` because the dashboard CSP
 * permits the badge host under `img-src` while keeping `connect-src 'self'`: a
 * JSON call to a third-party API would be blocked, an image is not. The numbers
 * live inside the image, so the `alt` names what is counted rather than the
 * figure — a reader who needs the exact number follows the link to the
 * repository, which is the only place it is authoritative.
 */
function badgeUrl(metric: "stars" | "forks", color: string): string {
  const params = new URLSearchParams({
    style: "flat-square",
    labelColor: "0b1220",
    color,
  });
  return `${BADGE_IMAGE_ORIGIN}/github/${metric}/${REPO_SLUG}?${params.toString()}`;
}

/** The GitHub mark, inlined so no brand-icon dependency is needed. */
export function GithubMark({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * Repository link with live star and fork counts. The host surface supplies the
 * chip styling; this component owns only the mark, the badges, and the target.
 */
export function GithubBadge({ className = "" }: { className?: string }): ReactElement {
  return (
    <a
      className={`github-badge ${className}`.trim()}
      href={GITHUB_REPO_URL}
      target="_blank"
      rel="noreferrer"
      aria-label="Cartethyia on GitHub"
    >
      <GithubMark size={15} />
      <img
        className="github-badge-metric"
        src={badgeUrl("stars", "2ea043")}
        alt="GitHub stars"
        height={20}
        loading="lazy"
        decoding="async"
      />
      <img
        className="github-badge-metric"
        src={badgeUrl("forks", "1f6feb")}
        alt="GitHub forks"
        height={20}
        loading="lazy"
        decoding="async"
      />
    </a>
  );
}
