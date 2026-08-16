import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";

import Overview from "../../../src/pages/Overview/index";
import { consoleGet } from "../../../src/lib/console-api";
import { apiCache } from "../../../src/lib/cache";

// Only the network reader is replaced; the contract normalizers stay real so
// the page is tested against the shapes it actually coerces.
vi.mock("../../../src/lib/console-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/console-api")>();
  return {
    ...actual,
    consoleGet: vi.fn(),
    consolePost: vi.fn(),
    consolePatch: vi.fn(),
    consoleDelete: vi.fn(),
  };
});

const dashboardPayload = {
  version: "2.1.0-beta",
  environment: "production",
  uptime: "3d 4h",
  accountCount: 2,
  proxyCount: 1,
  apiKeyCount: 3,
  health: { status: "ready" as const, dependencies: { database: "ready" as const }, memoryMb: 512 },
};

const telemetryOverviewPayload = {
  requests: 1200,
  errors: 30,
  p50Ms: 120,
  p95Ms: 480,
  p99Ms: 900,
  byRoute: { "/v1/chat/completions": 900 },
};

const errorBucketsPayload = {
  items: [
    {
      timestamp: "2026-08-16T08:00:00Z",
      count: 12,
      metadata: { code: "upstream_502", message: "provider timeout", provider: "openai", severity: "error" },
    },
  ],
};

function mockHappyPath(): void {
  vi.mocked(consoleGet).mockImplementation(async (route: string) => {
    if (route.startsWith("/telemetry/overview")) return telemetryOverviewPayload;
    if (route.startsWith("/telemetry/errors")) return errorBucketsPayload;
    return dashboardPayload;
  });
}

describe("Overview page", () => {
  beforeEach(() => {
    apiCache.clear();
    vi.mocked(consoleGet).mockReset();
    mockHappyPath();
  });

  test("reads the summary from the three documented console routes", async () => {
    render(() => <Overview />);

    await screen.findByText("1,200");

    expect(consoleGet).toHaveBeenCalledWith("/dashboard");
    expect(consoleGet).toHaveBeenCalledWith("/telemetry/overview?period=24h");
    expect(consoleGet).toHaveBeenCalledWith("/telemetry/errors?period=24h&limit=10");
  });

  test("renders metric cards from the combined payload", async () => {
    render(() => <Overview />);

    expect(screen.getByRole("heading", { level: 2, name: "Overview" })).toBeInTheDocument();
    // Requests and derived error rate (30 / 1200 = 2.5%).
    expect(await screen.findByText("1,200")).toBeInTheDocument();
    expect(screen.getByText("2.5%")).toBeInTheDocument();
    expect(screen.getByText("512")).toBeInTheDocument();
    // Provider accounts total from /dashboard.
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    // Badge timestamp appears once the resource resolves.
    expect(await screen.findByText(/^Fetched /)).toBeInTheDocument();
  });

  test("shows skeleton metrics first and resolves them without a reload", async () => {
    render(() => <Overview />);

    expect(screen.getByText("Metric 0")).toBeInTheDocument();
    expect(screen.getByText("Metric 3")).toBeInTheDocument();

    expect(await screen.findByText("1,200")).toBeInTheDocument();
    expect(screen.queryByText("Metric 0")).not.toBeInTheDocument();
  });

  test("renders the system health card and recent errors from the payloads", async () => {
    render(() => <Overview />);

    await screen.findByText("1,200");
    expect(screen.getByText("System health")).toBeInTheDocument();

    expect(screen.getByText("Uptime")).toBeInTheDocument();
    expect(screen.getByText("3d 4h")).toBeInTheDocument();
    expect(screen.getByText("Active providers")).toBeInTheDocument();
    expect(screen.getByText("512 MB")).toBeInTheDocument();

    expect(screen.getByText("Recent errors")).toBeInTheDocument();
    expect(screen.getByText("1 entries")).toBeInTheDocument();
    expect(screen.getByText("upstream_502")).toBeInTheDocument();
    expect(screen.getByText("provider timeout")).toBeInTheDocument();
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  test("shows the healthy empty state when no error buckets are reported", async () => {
    vi.mocked(consoleGet).mockImplementation(async (route: string) => {
      if (route.startsWith("/telemetry/overview")) return telemetryOverviewPayload;
      if (route.startsWith("/telemetry/errors")) return { items: [] };
      return dashboardPayload;
    });

    render(() => <Overview />);

    expect(await screen.findByText("No errors in the last 24 hours.")).toBeInTheDocument();
  });

  test("degrades to placeholders instead of crashing when every endpoint fails", async () => {
    vi.mocked(consoleGet).mockRejectedValue(new Error("network down"));

    render(() => <Overview />);

    await screen.findByText("No errors in the last 24 hours.");
    // All four metrics fall back to the em-dash unavailable marker.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
    // Uptime is unknown too.
    expect(screen.getByText("Last 24h routed traffic")).toBeInTheDocument();
    expect(screen.getByText("No errors reported")).toBeInTheDocument();
  });
});
