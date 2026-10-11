/**
 * The stylesheet cutover lock.
 *
 * The styling rebuild deletes the three per-app sheets — `console.css`,
 * `landing.css`, and `share.css` — so every surface styles through one dialect
 * (token → utility → primitive) and `app.css` keeps only the rules a utility
 * cannot express.
 *
 * The migration lands one app at a time, so `MIGRATED` is the list of apps
 * whose sheet is already gone. Each entry must have no sheet file, no entry
 * import of it, and no leftover feature selector in the shared base/app layers.
 * Legacy app sheets are intentionally excluded from that selector scan while
 * other apps still own them (for example, console share-management styles).
 * Bump this list in the same commit that deletes a sheet; it only ever grows.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DASHBOARD_ROOT = join(import.meta.dir, "..");
const STYLES = join(DASHBOARD_ROOT, "src", "styles");
const ENTRIES = join(DASHBOARD_ROOT, "src", "apps");

/** Apps whose per-app sheet has been deleted. Grows as each app is migrated. */
const MIGRATED = ["landing", "share", "console"] as const;

/** Legacy sheet file names, per app id. */
const SHEET_BY_APP: Record<string, string> = {
  console: "console.css",
  landing: "landing.css",
  share: "share.css",
};

/** Feature-selector prefixes a migrated app must no longer leave behind. */
const PREFIX_BY_APP: Record<string, string> = {
  console: "mlab",
  landing: "story",
  share: "share",
};

describe("stylesheet cutover", () => {
  test("every migrated app's sheet is deleted", () => {
    const present = MIGRATED.filter((app) => {
      const sheet = SHEET_BY_APP[app];
      return sheet !== undefined && existsSync(join(STYLES, sheet));
    });
    expect(present).toEqual([]);
  });

  test("no entry imports a migrated app's sheet", () => {
    const offenders: string[] = [];
    for (const app of MIGRATED) {
      const sheet = SHEET_BY_APP[app];
      if (sheet === undefined) continue;
      const entry = join(ENTRIES, app, "entry.tsx");
      if (!existsSync(entry)) continue;
      const src = readFileSync(entry, "utf8");
      if (src.includes(`styles/${sheet}`)) offenders.push(`${app}/entry.tsx`);
    }
    expect(offenders).toEqual([]);
  });

  test("no migrated app's feature selector remains in the shared sheets", () => {
    const offenders: string[] = [];
    const prefixes = MIGRATED.map((app) => PREFIX_BY_APP[app]).filter(
      (prefix): prefix is string => prefix !== undefined,
    );
    for (const sheet of ["base.css", "app.css"]) {
      const src = readFileSync(join(STYLES, sheet), "utf8");
      for (const match of src.matchAll(/^\s*\.([a-z][a-z0-9-]*)/gm)) {
        const name = match[1] ?? "";
        if (prefixes.some((prefix) => name.startsWith(`${prefix}-`))) {
          offenders.push(`${sheet}: ${match[0].trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
