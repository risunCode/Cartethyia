import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@solidjs/testing-library";

import Quota from "../../../src/pages/Quota/index";
import { consoleGet, consolePatch } from "../../../src/lib/console-api";
import { ApiError } from "../../../src/lib/api";
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

const accountsPayload = {
  items: [
    { id: "acct-a", providerId: "openai", label: "Primary", email: "ops@example.com", enabled: true },
    { id: "acct-b", providerId: "anthropic", label: "Relay", enabled: true },
    { id: "acct-c", providerId: "openai", label: "Retired", enabled: false },
  ],
};

const batchOk = { processed: 1, succeeded: 1, failed: 0 };

function mockHappyPath(): void {
  vi.mocked(consoleGet).mockImplementation(async (route: string) => {
    if (route === "/accounts") return accountsPayload;
    if (route === "/accounts/acct-a/quota") return { used: 90, limit: 100, remaining: 10 };
    if (route === "/accounts/acct-b/quota") return { used: 100, limit: 100, remaining: 0 };
    // Degraded probe => provider has no quota contract => filtered out.
    if (route === "/accounts/acct-c/quota") throw new ApiError(501, "not_implemented", "no quota endpoint");
    throw new Error(`unexpected route: ${route}`);
  });
  vi.mocked(consolePatch).mockResolvedValue(batchOk);
}

describe("Quota page", () => {
  beforeEach(() => {
    vi.mocked(consoleGet).mockReset();
    vi.mocked(consolePatch).mockReset();
    mockHappyPath();
    stubVirtualLayout();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("renders the quota summary, rows, and filtered-account note", async () => {
    render(() => <Quota />);

    expect(screen.getByRole("heading", { level: 2, name: "Quota Management" })).toBeInTheDocument();
    await screen.findByText("Relay");

    // Summary: 2 quota-visible accounts, both enabled, one exhausted, one filtered.
    expect(screen.getByText("Quota-visible accounts")).toBeInTheDocument();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1").length).toBeGreaterThan(0);
    expect(screen.getByText("Exhausted quota windows")).toBeInTheDocument();
    expect(screen.getByText("Filtered from this list")).toBeInTheDocument();

    expect(
      screen.getByText(/1 account hidden — the provider exposes no quota endpoint/),
    ).toBeInTheDocument();

    // Sorted by provider: anthropic Relay row before openai Primary row.
    expect(screen.getByText("90% used · 10 left")).toBeInTheDocument();
    expect(screen.getAllByText("Quota empty").length).toBeGreaterThan(0);
    expect(screen.getByText("anthropic")).toBeInTheDocument();
    expect(screen.getByText("openai")).toBeInTheDocument();
  });

  test("documents the console routes behind the page", async () => {
    render(() => <Quota />);

    await screen.findByText("Relay");
    expect(screen.queryByText("Endpoint reference")).not.toBeInTheDocument();
    expect(screen.queryByText("GET /console/accounts")).not.toBeInTheDocument();
    expect(screen.queryByText("PATCH /console/providers/:id/accounts/batch")).not.toBeInTheDocument();
    expect(screen.queryByText("DELETE /console/providers/:id/accounts/:accountId")).not.toBeInTheDocument();
  });

  test("toggles an account through the batch PATCH route and refetches", async () => {
    render(() => <Quota />);

    const toggle = await screen.findByRole("switch", { name: "Deactivate Primary" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);

    await vi.waitFor(() =>
      expect(consolePatch).toHaveBeenCalledWith("/providers/openai/accounts/batch", {
        items: [{ accountId: "acct-a", enabled: false }],
      }),
    );
    // The toggle triggers a snapshot refetch.
    await vi.waitFor(() => expect(vi.mocked(consoleGet).mock.calls.filter(([route]) => route === "/accounts").length).toBe(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("surfaces a failed batch update as an inline alert", async () => {
    vi.mocked(consolePatch).mockResolvedValue({ processed: 1, succeeded: 0, failed: 1, errors: ["account is locked"] });

    render(() => <Quota />);

    fireEvent.click(await screen.findByRole("switch", { name: "Deactivate Relay" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("account is locked");
  });

  test("deletes an account through the per-account DELETE route after confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    render(() => <Quota />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete Primary" }));

    expect(await screen.findByText("Delete account?")).toBeInTheDocument();
    // The dialog names the account and provider before the destructive action.
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();
    expect(screen.getAllByText("Primary").length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/console/providers/openai/accounts/acct-a",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await vi.waitFor(() => expect(vi.mocked(consoleGet).mock.calls.filter(([route]) => route === "/accounts").length).toBe(2));
  });

  test("surfaces a failed quota probe as a down row with the error message", async () => {
    // 403 is not a degraded probe, so the account stays visible with its error.
    vi.mocked(consoleGet).mockImplementation(async (route: string) => {
      if (route === "/accounts") return accountsPayload;
      if (route === "/accounts/acct-a/quota") return { used: 90, limit: 100, remaining: 10 };
      if (route === "/accounts/acct-b/quota") throw new ApiError(403, "forbidden", "quota read forbidden");
      if (route === "/accounts/acct-c/quota") throw new ApiError(501, "not_implemented", "no quota endpoint");
      throw new Error(`unexpected route: ${route}`);
    });

    render(() => <Quota />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("quota read forbidden");
    expect(screen.getAllByText("Down").length).toBeGreaterThan(0);
    expect(screen.getByText("Relay")).toBeInTheDocument();
  });

  test("renders the empty state when no accounts exist", async () => {
    vi.mocked(consoleGet).mockImplementation(async (route: string) => {
      if (route === "/accounts") return { items: [] };
      throw new Error(`unexpected route: ${route}`);
    });

    render(() => <Quota />);

    expect(await screen.findByText("No accounts are configured yet.")).toBeInTheDocument();
    expect(screen.getByText("0 quota-visible accounts · toggle active or delete")).toBeInTheDocument();
  });
});
