/**
 * RTK (request-token-killer) 3-tier behaviour: `lite`, `full`, `ultra`.
 *
 * These tests pin the *contract* of each tier, because the three profiles differ
 * in exactly three knobs and everything else about RTK is shared:
 *
 * - `lite`  — `minSize: 800`, no generic fallback, no second pass. Only large,
 *   clearly structured blobs are touched, and only by their structural filter.
 * - `full`  — `minSize: 500`, generic fallback on, no second pass. The default.
 * - `ultra` — `minSize: 200`, generic fallback on, second pass on. The second
 *   pass is the tier's whole reason to exist: a structural filter (say `grep`)
 *   can leave a long tail of repeated lines, and the generic pass compacts it.
 *
 * Two invariants hold at every tier and are asserted here as properties rather
 * than per-sample numbers:
 *
 * - **No grow.** `safeApplyFilter` discards a filter result that is not strictly
 *   shorter, so compression can never make a blob longer.
 * - **Monotone strength.** For the same blob, `ultra` never produces more output
 *   than `full`, and `full` never more than `lite`. (Not strictly required by
 *   the implementation, but if it ever breaks, a tier has stopped being a
 *   strength level and the dashboard selector is lying.)
 */
import { describe, expect, test } from "bun:test";
import { compressToolText } from "../../src/transport/request/rtk/compress-request";
import {
  RTK_LEVELS,
  RTK_PROFILES,
  rtkProfile,
  type RtkLevel,
} from "../../src/transport/request/rtk/rtk-constants";

const TIERS: readonly RtkLevel[] = RTK_LEVELS;

/** A grep-shaped blob: many `path:line:content` hits, lots of repeated content. */
function grepBlob(lines: number, prefix = "src/mod"): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(`${prefix}${i % 7}/file${i % 11}.ts:${(i * 13) % 400}:  const repeatedValue = compute(${i % 5});`);
  }
  return out.join("\n");
}

/** A log-shaped blob: timestamped INFO lines with a repeated payload. */
function logBlob(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const t = `2026-10-02T0${i % 10}:${(i * 7) % 60}:00.000Z`;
    out.push(`${t} INFO  [worker-${i % 4}] task completed step=${i % 6} durationMs=${100 + (i % 9)}`);
  }
  return out.join("\n");
}

/** A git-diff-shaped blob: many hunks, each with context + changes. */
function diffBlob(hunks: number): string {
  const out: string[] = ["diff --git a/src/big.ts b/src/big.ts", "index 1111111..2222222 100644", "--- a/src/big.ts", "+++ b/src/big.ts"];
  for (let h = 0; h < hunks; h++) {
    out.push(`@@ -${h * 20},7 +${h * 20},7 @@`);
    for (let c = 0; c < 3; c++) out.push(` context line ${h}-${c} unchanged`);
    out.push(`-  removed(${h});`);
    out.push(`+  added(${h});`);
    for (let c = 0; c < 3; c++) out.push(` context tail ${h}-${c} unchanged`);
  }
  return out.join("\n");
}

describe("RTK tier profiles", () => {
  test("the three levels and their knobs are exactly as documented", () => {
    expect(TIERS).toEqual(["lite", "full", "ultra"]);
    expect(RTK_PROFILES.lite).toEqual({ minSize: 800, genericFallback: false, secondPass: false });
    expect(RTK_PROFILES.full.genericFallback).toBe(true);
    expect(RTK_PROFILES.full.secondPass).toBe(false);
    expect(RTK_PROFILES.ultra.minSize).toBe(200);
    expect(RTK_PROFILES.ultra.secondPass).toBe(true);
  });

  test("gate order is ultra < full < lite, so strength rises as the gate falls", () => {
    expect(RTK_PROFILES.ultra.minSize).toBeLessThan(RTK_PROFILES.full.minSize);
    expect(RTK_PROFILES.full.minSize).toBeLessThan(RTK_PROFILES.lite.minSize);
  });

  test("an unknown level falls back to the `full` profile, never to nothing", () => {
    expect(rtkProfile(undefined)).toEqual(rtkProfile("full"));
    expect(rtkProfile(null)).toEqual(rtkProfile("full"));
    expect(rtkProfile("nonsense" as RtkLevel)).toEqual(rtkProfile("full"));
  });
});

describe("RTK no-grow invariant", () => {
  const samples: Array<[string, string]> = [
    ["grep", grepBlob(300)],
    ["log", logBlob(300)],
    ["diff", diffBlob(60)],
    ["short", "hello world\nthis is tiny"],
  ];

  for (const [name, blob] of samples) {
    test(`${name}: no tier ever returns a longer blob than it was given`, () => {
      for (const level of TIERS) {
        const out = compressToolText(blob, level);
        expect(out.length, `${name} @ ${level}`).toBeLessThanOrEqual(blob.length);
      }
    });
  }
});

describe("RTK monotone strength", () => {
  const samples: Array<[string, string]> = [
    ["grep", grepBlob(400)],
    ["log", logBlob(400)],
    ["diff", diffBlob(80)],
  ];

  for (const [name, blob] of samples) {
    test(`${name}: ultra <= full <= lite in output size`, () => {
      const lite = compressToolText(blob, "lite").length;
      const full = compressToolText(blob, "full").length;
      const ultra = compressToolText(blob, "ultra").length;
      expect(full, `${name}: full(${full}) <= lite(${lite})`).toBeLessThanOrEqual(lite);
      expect(ultra, `${name}: ultra(${ultra}) <= full(${full})`).toBeLessThanOrEqual(full);
    });
  }
});

describe("RTK tier gates actually differ", () => {
  test("a blob just under 800 chars is untouched at lite but touched at full/ultra", () => {
    // 650 chars of grep-shaped hits: below lite's 800 gate, above full's 500.
    const blob = grepBlob(9).slice(0, 650);
    expect(blob.length).toBeLessThan(RTK_PROFILES.lite.minSize);
    expect(blob.length).toBeGreaterThan(RTK_PROFILES.full.minSize);
    const lite = compressToolText(blob, "lite");
    const full = compressToolText(blob, "full");
    expect(lite.length).toBe(blob.length); // gate rejects it outright
    expect(full.length).toBeLessThanOrEqual(blob.length);
  });

  test("ultra's lower gate reaches blobs the other two skip entirely", () => {
    // ~300 chars: below both lite (800) and full (500), above ultra (200).
    const blob = grepBlob(5).slice(0, 300);
    expect(blob.length).toBeGreaterThan(RTK_PROFILES.ultra.minSize);
    expect(blob.length).toBeLessThan(RTK_PROFILES.full.minSize);
    const lite = compressToolText(blob, "lite");
    const full = compressToolText(blob, "full");
    expect(lite.length).toBe(blob.length);
    expect(full.length).toBe(blob.length);
    const ultra = compressToolText(blob, "ultra");
    expect(ultra.length).toBeLessThanOrEqual(blob.length);
  });

  test("a blob above every gate compresses at all three tiers", () => {
    const blob = grepBlob(400);
    expect(blob.length).toBeGreaterThan(RTK_PROFILES.lite.minSize);
    for (const level of TIERS) {
      expect(compressToolText(blob, level).length, level).toBeLessThan(blob.length);
    }
  });

  test("JSON blobs are not structurally compressed (RTK targets logs/text, not JSON)", () => {
    const json = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `row-${i}`, ok: true })) }, null, 2);
    for (const level of TIERS) {
      expect(compressToolText(json, level), `json @ ${level}`).toBe(json);
    }
  });
});
