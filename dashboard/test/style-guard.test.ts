/**
 * The styling ratchet.
 *
 * The rebuild's end state is zero static inline styles and zero arbitrary
 * literal utilities. Reaching it is a large migration; keeping it once reached
 * is what this test exists for. It measures every `.tsx` under `src/` and
 * compares the counts against `style-guard.json`:
 *
 * - a file may not exceed the count recorded for it (no new debt);
 * - a file absent from the manifest must have zero (new files start clean);
 * - a file may drop below its recorded count — that is the migration landing,
 *   and the manifest is lowered in the same commit.
 *
 * Regenerate the manifest after a migration step with:
 *
 * ```bash
 * STYLE_GUARD_UPDATE=1 bun test test/style-guard.test.ts
 * ```
 *
 * The manifest is committed, so lowering a number is a reviewable act rather
 * than an invisible side effect.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditTree, type StyleAudit } from "./helpers/style-audit";

const DASHBOARD_ROOT = join(import.meta.dir, "..");
const MANIFEST_PATH = join(DASHBOARD_ROOT, "style-guard.json");

/** Only files that still carry debt are stored, so a clean file is simply absent. */
type Manifest = Record<string, { staticInline: number; arbitrary: number }>;

function currentAudits(): StyleAudit[] {
  return auditTree(join(DASHBOARD_ROOT, "src"), "src");
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

/** Keeps only the files that still carry debt, sorted for a stable diff. */
function toManifest(audits: readonly StyleAudit[]): Manifest {
  const manifest: Manifest = {};
  for (const audit of [...audits].sort((a, b) => a.file.localeCompare(b.file))) {
    if (audit.staticInline === 0 && audit.arbitrary === 0) continue;
    manifest[audit.file] = { staticInline: audit.staticInline, arbitrary: audit.arbitrary };
  }
  return manifest;
}

describe("styling ratchet", () => {
  const audits = currentAudits();

  if (process.env["STYLE_GUARD_UPDATE"] === "1") {
    test("regenerates the manifest", () => {
      writeFileSync(MANIFEST_PATH, `${JSON.stringify(toManifest(audits), null, 2)}\n`);
      expect(true).toBe(true);
    });
    return;
  }

  const manifest = loadManifest();

  test("no file exceeds its recorded styling debt", () => {
    const regressions: string[] = [];
    for (const audit of audits) {
      const allowed = manifest[audit.file] ?? { staticInline: 0, arbitrary: 0 };
      if (audit.staticInline > allowed.staticInline) {
        regressions.push(
          `${audit.file}: static inline ${audit.staticInline} > allowed ${allowed.staticInline}`,
        );
      }
      if (audit.arbitrary > allowed.arbitrary) {
        regressions.push(
          `${audit.file}: arbitrary utilities ${audit.arbitrary} > allowed ${allowed.arbitrary}`,
        );
      }
    }
    expect(regressions).toEqual([]);
  });

  test("the manifest carries no stale entry whose file is now clean", () => {
    const byFile = new Map(audits.map((audit) => [audit.file, audit]));
    const stale: string[] = [];
    for (const [file, allowed] of Object.entries(manifest)) {
      const audit = byFile.get(file);
      if (!audit) {
        stale.push(`${file}: manifest entry but no such file`);
        continue;
      }
      if (audit.staticInline < allowed.staticInline || audit.arbitrary < allowed.arbitrary) {
        stale.push(
          `${file}: migrated below its allowance (${audit.staticInline}/${audit.arbitrary} vs ${allowed.staticInline}/${allowed.arbitrary}) — lower the manifest`,
        );
      }
    }
    expect(stale).toEqual([]);
  });
});
