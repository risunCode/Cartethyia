import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@solidjs/testing-library";

import Settings from "../../../src/pages/Settings/index";
import { consoleGet, consolePatch } from "../../../src/lib/console-api";
import { ApiError } from "../../../src/lib/api";

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

const settingsPayload = {
  theme: "dark",
  sidebarCollapsed: false,
  solidMode: true,
  performanceMode: false,
  notificationsEnabled: true,
  defaultModel: "gpt-5",
  apiKeys: [
    { id: "key-1", label: "prod-bot", prefix: "sk-abc", active: true, createdAt: "2026-08-01", lastUsedAt: "2026-08-15", scope: "chat" },
    { id: "key-2", label: "ci-runner", prefix: "sk-xyz", active: false, createdAt: "2026-08-02", lastUsedAt: null },
  ],
};

describe("Settings page", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(consoleGet).mockReset();
    vi.mocked(consolePatch).mockReset();
    vi.mocked(consoleGet).mockResolvedValue(settingsPayload);
    vi.mocked(consolePatch).mockResolvedValue(settingsPayload);
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test("renders the sections and API keys from the console settings payload", async () => {
    render(() => <Settings />);

    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(await screen.findByText("Synced")).toBeInTheDocument();

    expect(screen.getByText("Appearance")).toBeInTheDocument();
    expect(screen.getByText("Layout")).toBeInTheDocument();
    expect(screen.getByText("API keys")).toBeInTheDocument();
    expect(screen.getByText("2 active · managed via console PATCH")).toBeInTheDocument();

    expect(screen.getByText("prod-bot")).toBeInTheDocument();
    expect(screen.getByText("ci-runner")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
    expect(screen.getByText("sk-abc…")).toBeInTheDocument();

    expect(screen.getByText("Console session cookie")).toBeInTheDocument();
  });

  test("shows the loading indicator first and resolves without a reload", async () => {
    render(() => <Settings />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByText("prod-bot")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  test("patches the theme through the settings route when a scheme is picked", async () => {
    render(() => <Settings />);

    fireEvent.click(await screen.findByRole("button", { name: "Dark" }));

    await vi.waitFor(() => expect(consolePatch).toHaveBeenCalledWith("/settings", { theme: "dark" }));
    // A successful patch bumps the refresh tick and reads settings back.
    await vi.waitFor(() => expect(vi.mocked(consoleGet).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  test("creates an API key through the manager form", async () => {
    render(() => <Settings />);

    await screen.findByText("prod-bot");
    fireEvent.input(screen.getByLabelText("Label"), { target: { value: "staging-bot" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    await vi.waitFor(() =>
      expect(consolePatch).toHaveBeenCalledWith("/settings", {
        apiKeyAction: "create",
        apiKeyLabel: "staging-bot",
        apiKeyScope: "",
      }),
    );
  });

  test("revokes an existing key through the manager", async () => {
    render(() => <Settings />);

    await screen.findByText("prod-bot");
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]);

    await vi.waitFor(() =>
      expect(consolePatch).toHaveBeenCalledWith("/settings", { apiKeyAction: "revoke", apiKeyId: "key-1" }),
    );
  });

  test("surfaces a failed patch as an inline alert", async () => {
    vi.mocked(consolePatch).mockRejectedValue(new ApiError(403, "forbidden", "write blocked"));

    render(() => <Settings />);

    fireEvent.click(await screen.findByRole("button", { name: "System" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("write blocked");
  });
});
