import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED_PROVIDER_IDS } from "../../src/providers/provider-registry";
import { supportsAccountReset } from "../../src/providers/operations/account-reset-service";

/** Resolved from this file, not the process cwd: the suite runs both under
 * `bun run --cwd dashboard test` and under the repo-root `bun test`. */
const here = import.meta.dir;

/**
 * `ProviderIcon.tsx`'s `iconAssets` map and `Providers.tsx`'s
 * `FREE_LIMITED_IDS`/`FREE_AVAILABLE_IDS`/`FOUNDING_IDS` sets are
 * hand-maintained dashboard copies of backend provider IDs — they cannot import
 * the backend list without bundling its module graph into the browser build
 * (see `lib/provider-names.ts` for the same constraint).
 *
 * `provider-display-names-parity.test.ts` guards the display-name copy. These
 * two were the remaining unguarded ones, and the icon map had already drifted:
 * `workbuddy` had no entry, so `assetFor` fell through to a non-existent
 * `workbuddy.webp` and every WorkBuddy row showed initials instead of a logo.
 *
 * The check reads the sources as text because the maps are module-private; it
 * asserts coverage (every bundled ID is present), not exact equality, since
 * the icon map legitimately carries extra keys for ids a user may type into a
 * compatible-provider form.
 */
function parseSetIds(source: string, marker: string): string[] {
  const from = source.indexOf(marker);
  if (from < 0) throw new Error(`marker not found: ${marker}`);
  const to = source.indexOf("]);", from);
  return [...source.slice(from, to).matchAll(/"([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]!.toLowerCase());
}

function parseIconKeys(source: string): string[] {
  const from = source.indexOf("const iconAssets");
  const to = source.indexOf("function assetFor", from);
  return [...source.slice(from, to).matchAll(/^\s*"?([a-zA-Z0-9_-]+)"?:\s*\{ file:/gm)].map((m) =>
    m[1]!.toLowerCase(),
  );
}

describe("dashboard/backend parity — hand-maintained provider lists", () => {
  const bundled = BUNDLED_PROVIDER_IDS.map((id) => id.toLowerCase());

  test("every bundled provider has an icon asset entry", () => {
    const keys = new Set(parseIconKeys(readFileSync(join(here, "../src/components/ProviderIcon.tsx"), "utf8")));
    const missing = bundled.filter((id) => !keys.has(id));
    expect(missing).toEqual([]);
  });

  test("no free-tier or founding set names an unknown provider", () => {
    const source = readFileSync(join(here, "../src/routes/Providers.tsx"), "utf8");
    const known = new Set(bundled);
    for (const marker of [
      "const FREE_LIMITED_IDS = new Set([",
      "const FREE_AVAILABLE_IDS = new Set([",
      "const FOUNDING_IDS = new Set([",
    ]) {
      const stray = parseSetIds(source, marker).filter((id) => !known.has(id));
      expect(stray).toEqual([]);
    }
  });

  test("the dashboard reset-provider set matches the backend predicate", () => {
    // `lib/hooks/quota.ts` cannot import the backend predicate (it would bundle
    // node:crypto + the persistence graph into the browser build), so the set
    // is a hand-maintained mirror. Compare it behaviorally over every bundled
    // id: a provider the backend accepts but the card hides (or vice versa)
    // means the Reset button and `POST /accounts/:id/reset` disagree.
    const source = readFileSync(join(here, "../src/lib/hooks/quota.ts"), "utf8");
    const dashboardSet = new Set(parseSetIds(source, "const RESET_PROVIDER_IDS = new Set(["));
    const mismatched = bundled.filter((id) => dashboardSet.has(id) !== supportsAccountReset(id));
    expect(mismatched).toEqual([]);
  });
});
