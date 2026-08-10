import { describe, expect, test } from "vitest";
import {
  formatAccountHealthAccessibleStatus,
  formatAccountHealthStatus,
  formatRouteHealthStatus,
  healthPollingInterval,
  MAX_HEALTH_MESSAGE_LENGTH,
  MAX_VISIBLE_HEALTH_STATUS_LENGTH,
  type AccountHealthAccount,
} from "../../src/lib/account-health";

const NOW = Date.parse("2026-08-02T00:00:00.000Z");

function account(overrides: Partial<NonNullable<AccountHealthAccount["health"]>> = {}): AccountHealthAccount {
  return {
    active: true,
    health: {
      status: "error",
      errorKind: "rate_limited",
      statusCode: 429,
      sanitizedMessage: '{"error": "deepseek-v4-flash model is rate limited until 2026-08-02T00:29:49Z"}',
      retryAt: "2026-08-02T00:30:00.000Z",
      ...overrides,
    },
  };
}

describe("formatAccountHealthStatus", () => {
  test("keeps the upstream status and exact sanitized error inline", () => {
    expect(formatAccountHealthStatus(account(), NOW)).toBe(
      '[429]: {"error": "deepseek-v4-flash model is rate limited until 2026-08-02T00:29:49Z"} · retry in 30m',
    );
  });

  test("does not duplicate a status prefix already present in the provider message", () => {
    expect(formatAccountHealthStatus(account({ sanitizedMessage: '[429]: {"error":"rate limited"}' }), NOW)).toBe(
      '[429]: {"error":"rate limited"} · retry in 30m',
    );
  });

  test("does not show a stale error for healthy or refreshing accounts", () => {
    expect(formatAccountHealthStatus(account({ status: "healthy" }), NOW)).toBeNull();
    expect(formatAccountHealthStatus(account({ status: "refreshing" }), NOW)).toBeNull();
  });

  test("does not leak failure details for disabled accounts", () => {
    const disabled = account({ status: "disabled", statusCode: 401, sanitizedMessage: "secret upstream payload", retryAt: "2026-08-02T00:30:00.000Z" });
    expect(formatAccountHealthStatus({ ...disabled, active: false }, NOW)).toBe("Disabled");
    expect(formatAccountHealthStatus(disabled, NOW)).toBe("Disabled");
    expect(formatAccountHealthAccessibleStatus(disabled, NOW)).toBe("Disabled");
  });

  test("caps visible details while retaining bounded text for accessibility", () => {
    const message = "provider failure ".repeat(40);
    const health = account({ sanitizedMessage: message });
    const visible = formatAccountHealthStatus(health, NOW);
    const accessible = formatAccountHealthAccessibleStatus(health, NOW);
    expect(visible).not.toBeNull();
    expect(visible!.length).toBeLessThanOrEqual(MAX_VISIBLE_HEALTH_STATUS_LENGTH);
    expect(accessible).toContain("provider failure");
    expect(accessible!.length).toBeLessThanOrEqual(MAX_HEALTH_MESSAGE_LENGTH + 30);
    expect(accessible).not.toContain(message);
  });

  test("stops health polling while hidden", () => {
    expect(healthPollingInterval(true)).toBe(10_000);
    expect(healthPollingInterval(false)).toBe(false);
    expect(healthPollingInterval(true, 2_000)).toBe(2_000);
  });

  test("formats route health with SDK failureKind and status code", () => {
    expect(formatRouteHealthStatus({
      health: {
        status: "error",
        failureKind: "provider_rate_limited",
        statusCode: 429,
        sanitizedMessage: "upstream is busy",
        retryAt: "2026-08-02T00:30:00.000Z",
      },
    }, NOW)).toBe("[429]: upstream is busy · retry in 30m");
  });
});
