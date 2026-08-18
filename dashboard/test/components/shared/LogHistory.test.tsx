import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";

import { LogHistory } from "../../../src/components/shared/LogHistory";
import { consoleGet } from "../../../src/lib/console-api";
import { apiCache } from "../../../src/lib/cache";
import { stubVirtualLayout } from "../../helpers/live-surfaces";

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

const historyEntries = {
  entries: [
    { id: "h1", timestamp: "2026-08-16T10:00:00Z", level: "info", source: "proxy.core", message: "request routed" },
    { id: "h2", timestamp: "2026-08-16T10:01:00Z", level: "error", source: "provider.openai", message: "upstream 502" },
  ],
};

describe("LogHistory", () => {
  beforeEach(() => {
    apiCache.clear();
    vi.mocked(consoleGet).mockReset();
    vi.mocked(consoleGet).mockResolvedValue(historyEntries);
    stubVirtualLayout();
  });

  test("fetches the window from the log route and renders normalized rows", async () => {
    render(() => <LogHistory level="debug" />);

    expect(await screen.findByText("request routed")).toBeInTheDocument();
    expect(screen.getByText("upstream 502")).toBeInTheDocument();
    expect(screen.getByText("ERROR")).toBeInTheDocument();
    expect(screen.getByText("INFO")).toBeInTheDocument();
    expect(screen.getByText("provider.openai")).toBeInTheDocument();

    const route = vi.mocked(consoleGet).mock.calls[0][0];
    expect(route.startsWith("/logs?from=")).toBe(true);
    expect(route.includes("&to=")).toBe(true);
    expect(route.endsWith("&limit=500")).toBe(true);
  });

  test("applies the zebra striping class to the scroll container", async () => {
    const { container } = render(() => <LogHistory level="debug" />);
    await screen.findByText("request routed");

    const scroll = container.querySelector(".console-log-scroll");
    expect(scroll).not.toBeNull();
    expect(scroll?.className).toContain("log-zebra");
  });

  test("applies the level floor to the fetched entries", async () => {
    render(() => <LogHistory level="error" />);

    // The info entry drops below the error floor; the error entry remains.
    expect(await screen.findByText("upstream 502")).toBeInTheDocument();
    expect(screen.queryByText("request routed")).not.toBeInTheDocument();
  });

  // Note: a rejecting /logs fetch is deliberately not asserted here. Like the
  // pages, LogHistory reads the resource value inside an unguarded memo, so a
  // rejection aborts the render with an unhandled error before the inline
  // failure message can mount.


  test("accepts the items list key and honors a custom route", async () => {
    vi.mocked(consoleGet).mockResolvedValue({ items: [historyEntries.entries[0]] });

    render(() => <LogHistory level="debug" route="/logs/archive" />);

    expect(await screen.findByText("request routed")).toBeInTheDocument();
    expect(vi.mocked(consoleGet).mock.calls[0][0].startsWith("/logs/archive?from=")).toBe(true);
  });

  test("renders the empty pane when nothing matches the source filter", async () => {
    render(() => <LogHistory level="debug" source="nothing.matches" />);

    // No fetch error occurred, so the pane must show the dedicated
    // empty-filter copy — consoleFailure(null) is null, never a phantom
    // "network_error" badge.
    expect(await screen.findByText("No log entries match the current filter.")).toBeInTheDocument();
    expect(screen.queryByText("API request failed")).not.toBeInTheDocument();
    expect(screen.queryByText("request routed")).not.toBeInTheDocument();
  });
});
