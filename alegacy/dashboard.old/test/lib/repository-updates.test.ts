import { describe, expect, test } from "vitest";
import {
  isNewerRelease,
  isRepositoryUpdateAvailable,
  parseRepositoryBranch,
} from "../../src/lib/repository-updates";

const branchPayload = (branch: "main" | "dev", sha: string, date: string) => ({
  name: branch,
  commit: {
    sha,
    html_url: `https://github.com/risunCode/Cartethyia/commit/${sha}`,
    commit: { committer: { date } },
  },
});

describe("repository update detection", () => {
  test("parses branch commit metadata and ignores malformed responses", () => {
    const parsed = parseRepositoryBranch("main", branchPayload("main", "abc123", "2026-08-10T00:00:00Z"));
    expect(parsed).toMatchObject({ branch: "main", sha: "abc123", committedAt: Date.parse("2026-08-10T00:00:00Z") });
    expect(parseRepositoryBranch("dev", branchPayload("main", "abc123", "2026-08-10T00:00:00Z"))).toBeNull();
    expect(parseRepositoryBranch("main", { name: "main" })).toBeNull();
  });

  test("detects only remote commits newer than the running build", () => {
    const remote = parseRepositoryBranch("main", branchPayload("main", "remote", "2026-08-10T02:00:00Z"));
    expect(remote).not.toBeNull();
    if (remote === null) throw new Error("test branch metadata did not parse");
    expect(isRepositoryUpdateAvailable({ revision: "local", committedAt: Date.parse("2026-08-10T01:00:00Z"), startedAt: 0 }, remote)).toBe(true);
    expect(isRepositoryUpdateAvailable({ revision: "local", committedAt: Date.parse("2026-08-10T03:00:00Z"), startedAt: 0 }, remote)).toBe(false);
    expect(isRepositoryUpdateAvailable({ revision: "remote", committedAt: null, startedAt: 0 }, remote)).toBe(false);
  });

  test("compares release tags semantically", () => {
    expect(isNewerRelease("2.0.0-beta", "2.0.0")).toBe(true);
    expect(isNewerRelease("2.0.0-beta.2", "2.0.0-beta.10")).toBe(true);
    expect(isNewerRelease("2.0.0", "2.0.0-beta")).toBe(false);
    expect(isNewerRelease("2.0.0", "v2.0.0")).toBe(false);
  });
});
