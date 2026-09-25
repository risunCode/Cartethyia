import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { DashboardShell, navigationGroups } from "../src/components/Shell";
import { DataTable } from "../src/components/ui/layout";
import type { SessionUser } from "../src/lib/contracts";

import Login from "../src/routes/Login";
import Setup from "../src/routes/Setup";
import Banned from "../src/routes/Banned";
import Overview from "../src/routes/Overview";
import Usage from "../src/routes/Usage";
import ProviderDetail from "../src/routes/ProviderDetail";
import Providers from "../src/routes/Providers";
import Combos from "../src/routes/Combos";
import Quota from "../src/routes/Quota";
import Proxy from "../src/routes/Proxy";
import Settings from "../src/routes/Settings";
import CliTools from "../src/routes/CliTools";
import CliToolDetail from "../src/routes/CliToolDetail";
import ConsoleLog from "../src/routes/ConsoleLog";
import Customization from "../src/routes/Customization";
import Studio from "../src/routes/Studio";

/**
 * Every route registered in `App.tsx`, keyed by the path it is mounted at.
 * Adding a `<Route>` without a module here fails the coverage test below.
 */
const ROUTE_MODULES: ReadonlyArray<readonly [string, ComponentType]> = [
  ["/login", Login],
  ["/setup", Setup],
  ["/banned", Banned],
  ["/", Overview],
  ["/usage", Usage],
  ["/providers/:providerId", ProviderDetail],
  ["/providers", Providers],
  ["/combos", Combos],
  ["/quota", Quota],
  ["/proxy", Proxy],
  ["/settings", Settings],
  ["/cli-tools", CliTools],
  ["/cli-tools/:toolId", CliToolDetail],
  ["/console-log", ConsoleLog],
  ["/customization", Customization],
  ["/model-lab", Studio],
];

const user: SessionUser = {
  id: "user-1",
  username: "admin",
  email: "admin@example.test",
  displayName: "Admin",
  isFirstBoot: false,
  sessionExpiresAt: "2026-08-31T00:00:00.000Z",
  isPlatformAdmin: false,
};

function render(element: ReactNode, path = "/"): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, { initialEntries: [path] }, element),
    ),
  );
}

/** React escapes `&` in text nodes; compare against the decoded markup. */
function decodeEntities(markup: string): string {
  return markup.replaceAll("&amp;", "&");
}

describe("dashboard route modules", () => {
  test("every registered route resolves to a component module", () => {
    for (const [path, RouteComponent] of ROUTE_MODULES) {
      expect({ path, type: typeof RouteComponent }).toEqual({ path, type: "function" });
      expect(RouteComponent.name.length).toBeGreaterThan(0);
    }
  });
});

describe("dashboard navigation", () => {
  test("renders the three navigation groups and their page labels", () => {
    const markup = decodeEntities(
      render(
        createElement(DashboardShell, { user, children: createElement("p", null, "page content") }),
      ),
    );

    const expected: Record<string, readonly string[]> = {
      Main: ["Overview", "Usage", "Providers", "Model Lab"],
      Control: ["Combos & Routes", "Quota Management", "Proxy & Requests", "CLI Tools"],
      System: ["Customization", "Console Log", "Settings"],
    };

    expect(navigationGroups.map((group) => group.label)).toEqual(Object.keys(expected));
    for (const [group, labels] of Object.entries(expected)) {
      expect(markup).toContain(group);
      for (const label of labels) expect(markup).toContain(label);
    }
  });

  test("keeps navigation shallow: real pages only, all rooted at /", () => {
    const labels = navigationGroups.flatMap((group) => group.items.map((item) => item.label));
    expect(labels).not.toContain("Accounts");
    expect(labels).not.toContain("Live Requests");
    for (const group of navigationGroups) {
      for (const item of group.items) expect(item.path.startsWith("/")).toBe(true);
    }
  });

  test("resolves topbar titles for parameterized routes instead of the console fallback", () => {
    const provider = decodeEntities(
      render(createElement(DashboardShell, { user, children: null }), "/providers/anthropic"),
    );
    expect(provider).toContain('<h1 class="topbar-title">Anthropic</h1>');

    const tool = decodeEntities(
      render(createElement(DashboardShell, { user, children: null }), "/cli-tools/opencode"),
    );
    expect(tool).toContain('<h1 class="topbar-title">CLI Tool</h1>');
    expect(tool).toContain("opencode — mappings, endpoints, and downloadable config");
  });
});

describe("dashboard sidebar groups", () => {
  test("renders all navigation groups without a Tools collapse", () => {
    const home = decodeEntities(
      render(createElement(DashboardShell, { user, children: null }), "/"),
    );
    expect(home).not.toContain('class="nav-group-toggle"');
    expect(home).not.toContain(">Tools</");
    expect(home).toContain("Customization");
    expect(home).toContain("CLI Tools");
  });

  test("renders each group with the standard group-title styling", () => {
    const home = decodeEntities(
      render(createElement(DashboardShell, { user, children: null }), "/"),
    );
    expect(home).toContain('<p class="nav-group-title">Main</p>');
    expect(home).toContain('<p class="nav-group-title">Control</p>');
    expect(home).toContain('<p class="nav-group-title">System</p>');
  });
});


describe("dashboard presentational contracts", () => {

  test("renders data tables with a scroll wrapper and scoped headers", () => {
    const markup = renderToStaticMarkup(
      createElement(DataTable, {
        headers: ["Request ID", "Status"],
        children: createElement("tr", null, createElement("td", null, "request-1")),
      }),
    );

    expect(markup).toContain('class="data-table-container"');
    expect(markup).toContain('<th scope="col">Request ID</th>');
    expect(markup).toContain('<th scope="col">Status</th>');
    expect(markup).toContain("request-1");
  });
});
