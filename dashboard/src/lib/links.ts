/**
 * Public repository links, in one place.
 *
 * These were declared twice: one copy in the console shell built them from a
 * repo slug, and the share page's badge component carried its own hardcoded URL
 * plus a second copy of the slug for the shields.io badges. Two literals for
 * one repository means a rename moves one surface and leaves the other pointing
 * at the old project, so every link and every badge resolves from here.
 */

export const GITHUB_REPO = "risunCode/Cartethyia";
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO}`;
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;
