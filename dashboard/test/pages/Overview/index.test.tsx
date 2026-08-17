import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";

import Overview from "../../../src/pages/Overview/index";
import { consoleGet } from "../../../src/lib/console-api";

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
  health: { database: "postgresql", redis: "degraded" },
};

describe("Overview page", () => {
  beforeEach(() => {
    vi.mocked(consoleGet).mockReset();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("renders the API endpoint card with a copy button for the /v1 base URL", async () => {
    vi.mocked(consoleGet).mockResolvedValue(dashboardPayload);
    render(() => <Overview />);

    expect(await screen.findByText(/\/v1$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  test("copying the endpoint flips the button to Copied via the clipboard", async () => {
    vi.mocked(consoleGet).mockResolvedValue(dashboardPayload);
    render(() => <Overview />);
    const button = await screen.findByRole("button", { name: /copy/i });
    button.click();
    await vi.waitFor(() => expect(screen.getByText("Copied")).toBeInTheDocument());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("/v1"));
  });


  test("shows the failure panel with Retry when /dashboard cannot be read", async () => {
    vi.mocked(consoleGet).mockRejectedValue(new Error("network down"));
    render(() => <Overview />);

    expect(await screen.findByText("Unable to load overview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
