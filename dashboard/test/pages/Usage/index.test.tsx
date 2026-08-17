import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@solidjs/testing-library";

import Usage from "../../../src/pages/Usage/index";
import { consoleGet } from "../../../src/lib/console-api";
import { apiCache } from "../../../src/lib/cache";
import { ApiError } from "../../../src/lib/api";
import { FakeEventSource, stubEventSource, stubVirtualLayout } from "../../helpers/live-surfaces";

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

const usageTotals = { requests: 5432, input_tokens: 1_200_000, output_tokens: 2_500_000 };
const requestSeries = {
  items: [
    { timestamp: "2026-08-16T10:00:00Z", count: 40, errors: 2, latencyMs: 120 },
    { timestamp: "2026-08-16T11:00:00Z", count: 60, errors: 1, latencyMs: 150 },
  ],
};
const errorBuckets = { items: [{ count: 3 }, { count: 4 }] };

function mockHappyPath(): void {
  vi.mocked(consoleGet).mockImplementation(async (route: string) => {
    if (route.startsWith("/telemetry/usage")) return usageTotals;
    if (route.startsWith("/telemetry/requests")) return requestSeries;
    if (route.startsWith("/telemetry/errors")) return errorBuckets;
    throw new Error(`unexpected route: ${route}`);
  });
}

describe("Usage page", () => {
  beforeEach(() => {
    apiCache.clear();
    vi.mocked(consoleGet).mockReset();
    mockHappyPath();
    stubEventSource();
    stubVirtualLayout();
  });

  afterEach(() => {
    FakeEventSource.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("renders summary metrics and period totals from the telemetry payloads", async () => {
    render(() => <Usage />);

    expect(screen.getByRole("heading", { level: 2, name: "Usage" })).toBeInTheDocument();
    // Requests show in both the metric card and the period totals snapshot.
    expect((await screen.findAllByText("5,432")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.2M").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2.5M").length).toBeGreaterThan(0);
    // Errors are summed across /telemetry/errors buckets (3 + 4).
    expect(screen.getAllByText("7").length).toBeGreaterThan(0);

  });

  test("renders the request chart once buckets resolve and reports the point count", async () => {
    render(() => <Usage />);

    expect(screen.getByLabelText("Loading usage chart")).toBeInTheDocument();

    const chart = await screen.findByRole("img", { name: "Requests per bucket" });
    expect(chart).toBeInTheDocument();
    expect(screen.getByText("2 pts")).toBeInTheDocument();
    expect(screen.getByText("Buckets for 24h")).toBeInTheDocument();
  });

  test("subscribes to the in-flight stream through the console stream URL", async () => {
    render(() => <Usage />);

    await screen.findAllByText("5,432");
    const stream = FakeEventSource.instances.find((source) => source.url === "/console/telemetry/in-flight/stream");
    expect(stream).toBeDefined();
    expect(screen.getByText("Waiting for first in-flight event…")).toBeInTheDocument();
  });

  test("refetches with the selected period when the time range changes", async () => {
    render(() => <Usage />);

    await screen.findAllByText("5,432");
    fireEvent.change(screen.getByLabelText("Usage time range"), { target: { value: "7d" } });

    await screen.findByText("Buckets for 7d");
    expect(consoleGet).toHaveBeenCalledWith(expect.stringContaining("/telemetry/usage?"));
    expect(vi.mocked(consoleGet).mock.calls.some(([route]) => route.includes("period=7d"))).toBe(true);
  });

  test("shows the empty telemetry panel when the series has no buckets", async () => {
    vi.mocked(consoleGet).mockImplementation(async (route: string) => {
      if (route.startsWith("/telemetry/requests")) return { items: [] };
      if (route.startsWith("/telemetry/errors")) return { items: [] };
      return usageTotals;
    });

    render(() => <Usage />);

    expect(await screen.findByText("No request telemetry")).toBeInTheDocument();
    expect(screen.getByText("There is no request telemetry for this period.")).toBeInTheDocument();
  });

  test("tolerates a failing errors endpoint by degrading only the error metric", async () => {
    vi.mocked(consoleGet).mockImplementation(async (route: string) => {
      if (route.startsWith("/telemetry/errors")) throw new ApiError(500, "server_error", "errors store down");
      if (route.startsWith("/telemetry/usage")) return usageTotals;
      return requestSeries;
    });

    render(() => <Usage />);

    // The page still renders from usage + series; the error total is unknown.
    expect((await screen.findAllByText("5,432")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
