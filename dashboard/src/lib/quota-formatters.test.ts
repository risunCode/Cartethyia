import { describe, expect, test } from "bun:test";
import {
  formatQuotaWindowLabel,
  formatResetDistance,
  friendlyQuotaError,
  quotaBarTone,
  accountIdentity,
} from "./quota-formatters";

describe("quota display formatters", () => {
  test("uses named windows and converts hour labels to days", () => {
    expect(formatQuotaWindowLabel("168 Hour")).toBe("Weekly");
    expect(formatQuotaWindowLabel("167 hour")).toBe("6d 23h");
    expect(formatQuotaWindowLabel("720 hour")).toBe("Monthly");
    expect(formatQuotaWindowLabel("24 hour")).toBe("Daily");
    expect(formatQuotaWindowLabel("5 hour")).toBe("5h");
  });

  test("does not render placeholder punctuation for missing reset times", () => {
    expect(formatResetDistance(null)).toBe("");
  });

  test("formats future reset distance correctly", () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    expect(formatResetDistance(future)).toBe("Resets in 2mins");
  });

  test("labels non-recurring CodeBuddy bonus windows as expirations", () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    expect(formatResetDistance(future, false)).toBe("Expires in 2mins");
  });

  test("prioritizes OAuth invalidation over quota wording", () => {
    expect(friendlyQuotaError("OAuth account invalidated; reauthorization required")).toBe(
      "OAuth account invalidated — re-login required",
    );
    expect(friendlyQuotaError("Rate limit exceeded 429")).toBe(
      "Quota exhausted or rate limited — wait for reset",
    );
  });

  test("assigns bar tones based on remaining percent thresholds", () => {
    expect(quotaBarTone(10).bar).toBe("var(--red)");
    expect(quotaBarTone(40).bar).toBe("var(--orange)");
    expect(quotaBarTone(80).bar).toBe("var(--green)");
    expect(quotaBarTone(null).bar).toBe("var(--text-tertiary)");
  });

  test("resolves account identity prioritizing email and cleaning tokens", () => {
    const emailIdent = accountIdentity("user@example.com", "My Account");
    expect(emailIdent.primary).toBe("user@example.com");
    expect(emailIdent.secondary).toBe("My Account");

    const nonEmailIdent = accountIdentity("team-pro", "Account 1");
    expect(nonEmailIdent.primary).toBe("Account 1");
    expect(nonEmailIdent.secondary).toBe("team-pro");
  });

  test("hides credential-kind hints from account identity", () => {
    for (const kind of ["oauth", "api_key", "none"]) {
      const ident = accountIdentity(kind, "My Account");
      expect(ident.primary).toBe("My Account");
      expect(ident.secondary).toBeNull();
    }
  });
});
