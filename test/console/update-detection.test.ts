/**
 * Update detection: the version ordering behind the sidebar badge, and the
 * route that answers it.
 *
 * The badge is only honest if it stays quiet when it should. A badge that lights
 * up because a comparison is wrong is worse than no badge: it tells an operator
 * to upgrade a build that is already current, or hides a release behind a dev
 * version it cannot be compared against. So the ordering cases — prerelease vs
 * release, numeric vs alphanumeric identifiers, unparseable input — are the
 * point of this file, not the happy path.
 */
import { describe, expect, test } from "bun:test";
import { compareVersions, isNewerRelease, parseVersion } from "../../src/console/updates/version-compare";
import { createTestGateway, type TestGateway } from "../helpers/gateway";

describe("parseVersion", () => {
  test("reads a bare semver triple", () => {
    expect(parseVersion("1.2.3")).toEqual({ core: [1, 2, 3], prerelease: [] });
  });

  test("a leading v and trailing build metadata are both ignored", () => {
    // GitHub tags are `v2.0.1`; a `+build` suffix is semver metadata and must
    // not affect ordering.
    expect(parseVersion("v2.0.1")).toEqual({ core: [2, 0, 1], prerelease: [] });
    expect(parseVersion("2.0.1+sha.abc")).toEqual({ core: [2, 0, 1], prerelease: [] });
  });

  test("splits a prerelease into numeric and alphanumeric identifiers", () => {
    expect(parseVersion("1.0.0-rc.1")).toEqual({ core: [1, 0, 0], prerelease: ["rc", 1] });
  });

  test("rejects a partial or non-numeric core", () => {
    // `2.0` is a real version string an operator may see, but comparing it as
    // semver would silently read as `2.0.0`.
    expect(parseVersion("2.0")).toBeNull();
    expect(parseVersion("dev")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("isNewerRelease — ordering", () => {
  test("a higher core version is newer", () => {
    expect(isNewerRelease("2.0.0", "2.0.1")).toBe(true);
    expect(isNewerRelease("2.0.1", "2.0.0")).toBe(false);
  });

  test("an identical version is not an update", () => {
    expect(isNewerRelease("2.0.0", "2.0.0")).toBe(false);
    expect(isNewerRelease("2.0.0", "v2.0.0")).toBe(false);
  });

  test("a release outranks its own prerelease", () => {
    // 1.0.0 ships after 1.0.0-rc.1. Getting this backwards would tell everyone
    // running a release candidate that no update exists.
    expect(isNewerRelease("1.0.0-rc.1", "1.0.0")).toBe(true);
    expect(isNewerRelease("1.0.0", "1.0.0-rc.1")).toBe(false);
  });

  test("prereleases order among themselves", () => {
    expect(isNewerRelease("1.0.0-alpha.1", "1.0.0-alpha.2")).toBe(true);
    expect(isNewerRelease("1.0.0-alpha", "1.0.0-beta")).toBe(true);
  });

  test("an absent side is never an update", () => {
    // Both are unknown until their query lands; a half-answered comparison must
    // not invent a badge.
    expect(isNewerRelease(undefined, "2.0.1")).toBe(false);
    expect(isNewerRelease("2.0.0", undefined)).toBe(false);
  });

  test("an unparseable side falls back to string inequality", () => {
    // A dev build labelled `2.0-dev` cannot be ordered numerically, so it stays
    // quiet unless the tag literally differs.
    expect(isNewerRelease("2.0-dev", "2.0-dev")).toBe(false);
    expect(isNewerRelease("2.0-dev", "2.1-dev")).toBe(true);
  });
});

describe("compareVersions", () => {
  test("numeric identifiers rank below alphanumeric ones", () => {
    const alpha = parseVersion("1.0.0-alpha");
    const numeric = parseVersion("1.0.0-1");
    expect(alpha).not.toBeNull();
    expect(numeric).not.toBeNull();
    expect(compareVersions(alpha!, numeric!)).toBe(1);
    expect(compareVersions(numeric!, alpha!)).toBe(-1);
  });

  test("equal versions compare as zero", () => {
    const left = parseVersion("1.2.3");
    const right = parseVersion("1.2.3");
    expect(compareVersions(left!, right!)).toBe(0);
  });
});

describe("/console/api/updates/release", () => {
  let gateway: TestGateway;

  test("answers without a session, and shapes a known release", async () => {
    gateway = await createTestGateway();
    try {
      const response = await gateway.request("/console/api/updates/release", { method: "GET" });
      // The route is public release metadata and mounts without a session —
      // `/console/api/system/health` next to it answers 401, which is what makes
      // this 200 worth pinning. What GitHub answered decides the body, so this
      // pins the *shape*, not the value: either `null` or both fields together.
      expect(response.status).toBe(200);
      // Elysia serializes a `null` handler result as an empty body, so "no
      // release known" reaches the client as no content at all.
      const text = await response.text();
      if (text.trim().length === 0) return;
      const body = JSON.parse(text) as unknown;
      expect(typeof (body as { tag_name?: unknown }).tag_name).toBe("string");
      expect(typeof (body as { html_url?: unknown }).html_url).toBe("string");
    } finally {
      await gateway.close();
    }
  });
});
