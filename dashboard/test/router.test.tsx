import { describe, expect, test } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { Route, Router } from "@solidjs/router";

import { DashboardShell } from "../src/router";

describe("DashboardShell", () => {
  test("wraps routed content with the persistent sidebar, header, and footer chrome", async () => {
    render(() => (
      <Router root={(props) => <>{props.children}</>}>
        <Route
          path="/"
          component={() => (
            <DashboardShell>
              <div data-testid="page-content">Overview content</div>
            </DashboardShell>
          )}
        />
      </Router>
    ));

    // Sidebar: primary navigation landmark with every route wired in router.tsx.
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav).toBeInTheDocument();
    for (const label of ["Overview", "Usage", "Providers", "Quota", "Console log", "Share", "Settings"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }

    // Header: global app bar with sign-out affordance.
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "User menu" })).toBeInTheDocument();

    // Footer status renders once the (mocked-by-network-failure) health probe settles.
    expect(await screen.findByText(/Unknown|Operational/)).toBeInTheDocument();

    // Routed page content renders inside the shell's <main>.
    const content = screen.getByTestId("page-content");
    expect(content).toBeInTheDocument();
    expect(content.closest("main")).not.toBeNull();
  });
});
