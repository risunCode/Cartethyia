import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { DashboardShell } from "../src/components/Shell";
import Settings from "../src/routes/Settings";
import { queryKeys } from "../src/lib/query-keys";
import type { SessionUser } from "../src/lib/contracts";

const user: SessionUser = {
  id: "user-1",
  username: "admin",
  email: "admin@example.test",
  displayName: "Admin",
  isFirstBoot: false,
  sessionExpiresAt: "2026-08-31T00:00:00.000Z",
  isPlatformAdmin: false,
};

describe("dashboard components", () => {
  test("renders the authenticated shell with named navigation and command controls", () => {
    const shell = createElement(
      MemoryRouter,
      { initialEntries: ["/"] },
      createElement(DashboardShell, {
        user,
        children: createElement("p", null, "page content"),
      }),
    );
    const markup = renderToStaticMarkup(shell);

    expect(markup).toContain('aria-label="Dashboard navigation"');
    expect(markup).toContain('aria-label="Open navigation"');
    expect(markup).toContain("Overview");
    expect(markup).toContain("Settings");
    expect(markup).toContain("Command palette");
    expect(markup).toContain("Sign out");
    expect(markup).toContain("page content");
  });

  test("renders Settings privacy controls without env-driven runtime controls", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.settings.runtime, {
      redisModeActual: "normal",
      tenantConcurrencyLimit: null,
      responsesReasoningSummary: "detailed",
      telemetryPayloads: "bounded",
      privacyMode: "masked",
      updatedAt: "2026-09-04T00:00:00.000Z",
    });

    const markup = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient }, createElement(Settings)),
    );

    expect(markup).toContain("Privacy");
    expect(markup).toContain("Telemetry payloads");
    expect(markup).toContain("Client IP display");
    // Payload retention is 15 minutes server-side
    // (`CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS`); the copy must not
    // advertise a different window.
    expect(markup).toContain("pruned after 15 minutes");
    expect(markup).toContain("deleted automatically after 15 minutes");
    expect(markup).not.toContain("1 hour");
    expect(markup).not.toContain("Runtime Preferences");
    expect(markup).not.toContain("Redis mode");
    expect(markup).not.toContain("Tenant concurrency limit");

  });
});
